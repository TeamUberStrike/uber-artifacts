const GITHUB_API = 'https://api.github.com';
const PAGE_SIZE = 100;
const MAX_ARTIFACT_PAGES = 5;
const MAX_RUN_DETAIL_LOOKUPS = 15;
const MAX_RUN_DETAIL_LOOKUPS_CRON = 20;
const MAX_JOB_LOOKUPS = 15;
const MAX_JOB_LOOKUPS_CRON = 20;
const MAX_PR_TITLE_LOOKUPS = 100;
const MAX_REST_TITLE_FALLBACK = 12;
const CACHE_TTL_SECONDS = 60;
const BUILD_TYPES = [
  ['Windows', ['windows', 'win64', 'win32', 'standalonewindows']],
  ['Android', ['android']],
  ['iOS', ['ios', 'iphone', 'ipad']],
  ['Linux', ['linux', 'standalonelinux']],
  ['macOS', ['macos', 'osx', 'mac os', 'standalonemacos']],
  ['WebGL', ['webgl']]
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function allowlist(env) {
  return (env.ALLOWED_REPOS || '')
    .split(',')
    .map((repo) => repo.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowed(repo, env) {
  return allowlist(env).includes(repo.toLowerCase());
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const configured = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.includes('*')) return '*';
  if (origin && configured.includes(origin)) return origin;
  return '';
}

function corsHeaders(request, env) {
  const headers = new Headers();
  const origin = allowedOrigin(request, env);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    if (origin !== '*') headers.set('Vary', 'Origin');
  }
  return headers;
}

function baseHeaders(request, env, contentType) {
  const headers = corsHeaders(request, env);
  if (contentType) headers.set('Content-Type', contentType);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return headers;
}

function jsonResponse(request, env, body, status = 200, cacheSeconds = 0, extraHeaders = {}) {
  const headers = baseHeaders(request, env, 'application/json; charset=utf-8');
  headers.set('Cache-Control', cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store');
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  if (request.method === 'HEAD') {
    return new Response(null, { status, headers });
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function preflight(request, env) {
  const headers = baseHeaders(request, env);
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Accept, Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function githubHeaders(env, accept = 'application/vnd.github+json') {
  const headers = {
    Accept: accept,
    'User-Agent': 'uber-artifacts-proxy',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

async function githubFetch(env, path) {
  if (!env.GITHUB_TOKEN) {
    throw new HttpError(500, 'GITHUB_TOKEN is not configured on the proxy');
  }
  return fetch(GITHUB_API + path, { headers: githubHeaders(env) });
}

async function githubErrorMessage(response, action) {
  let detail = '';
  try {
    const body = await response.json();
    if (body && body.message) detail = `: ${body.message}`;
  } catch {}
  return `GitHub API failed to ${action} (${response.status})${detail}`;
}

function clientIp(request) {
  const forwarded = request.headers.get('CF-Connecting-IP');
  if (forwarded) return forwarded;
  const real = request.headers.get('X-Forwarded-For');
  if (real) return real.split(',')[0].trim();
  return 'unknown';
}

function makeRateLimiter(max, windowMs) {
  const hits = new Map();
  return {
    check(ip) {
      const now = Date.now();
      const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
      recent.push(now);
      hits.set(ip, recent);
      if (hits.size > 20000) {
        for (const [key, stamps] of hits) {
          if (now - stamps[stamps.length - 1] > windowMs) hits.delete(key);
        }
      }
      return recent.length <= max;
    }
  };
}

const listLimiter = makeRateLimiter(30, 60 * 1000);
const downloadLimiter = makeRateLimiter(10, 60 * 1000);

function detectBuildType(values) {
  for (const value of values) {
    const text = (value || '').toLowerCase();
    if (!text) continue;
    for (const [name, aliases] of BUILD_TYPES) {
      if (aliases.some((alias) => text.includes(alias))) return name;
    }
  }
  return '';
}

function detectBuildTypeFromName(name) {
  const match = /^(?:[^\-_.]+[\-_.])?(windows|win64|win32|android|ios|iphone|ipad|linux|macos|osx|mac os|webgl|standalonewindows|standalonelinux|standalonemacos)(?=[\-_.])/i.exec(name || '');
  if (!match) return '';
  const token = match[1].toLowerCase();
  for (const [type, aliases] of BUILD_TYPES) {
    if (aliases.includes(token)) return type;
  }
  return '';
}

function extractBuildHash(name) {
  const match = /([0-9a-f]{40})$/i.exec(name || '');
  return match ? match[1].toLowerCase() : '';
}

function isSafeRepoPart(value) {
  return /^[\w.-]+$/.test(value || '');
}

async function fetchPullRequestTitles(env, owner, name, numbers) {
  if (!numbers.length) return { titles: new Map(), graphqlOk: true };
  const aliases = numbers.map((number) => `p${number}: pullRequest(number: ${number}) { title }`).join('\n');
  const query = `query { repository(owner: "${owner}", name: "${name}") { ${aliases} } }`;
  const response = await fetch(`${GITHUB_API}/graphql`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'uber-artifacts-proxy',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`
    },
    body: JSON.stringify({ query })
  });
  if (!response.ok) return { titles: new Map(), graphqlOk: false };
  const data = await response.json();
  const titles = new Map();
  const nodes = (data && data.data && data.data.repository) || {};
  for (const number of numbers) {
    const node = nodes[`p${number}`];
    if (node && typeof node.title === 'string') titles.set(number, node.title);
  }
  return { titles, graphqlOk: true };
}

async function fetchPullRequestTitlesRest(env, repo, numbers, cap = MAX_REST_TITLE_FALLBACK) {
  const titles = new Map();
  const targets = numbers.slice(0, cap);
  await Promise.all(targets.map(async (number) => {
    try {
      const response = await githubFetch(env, `/repos/${repo}/pulls/${number}`);
      if (!response.ok) return;
      const pullRequest = await response.json();
      titles.set(number, pullRequest.title || '');
    } catch {}
  }));
  return titles;
}

const METADATA_TTL_SECONDS = 30 * 24 * 60 * 60;

function runMetaKey(repo, runId) {
  return `https://artifacts-proxy.invalid/run/${repo.toLowerCase()}/${runId}`;
}

function prTitleKey(repo, number) {
  return `https://artifacts-proxy.invalid/pr/${repo.toLowerCase()}/${number}`;
}

async function cacheGet(key) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (!cache) return null;
  return cache.match(key);
}

async function cachePutJson(key, value) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (!cache) return;
  const response = new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${METADATA_TTL_SECONDS}` }
  });
  await cache.put(key, response);
}

async function fetchArtifactContext(repo, env) {
  const artifacts = [];
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page++) {
    const response = await githubFetch(env, `/repos/${repo}/actions/artifacts?per_page=${PAGE_SIZE}&page=${page}`);
    if (!response.ok) {
      throw new HttpError(response.status, await githubErrorMessage(response, 'list artifacts'));
    }
    const data = await response.json();
    const pageArtifacts = data.artifacts || [];
    artifacts.push(...pageArtifacts);
    if (pageArtifacts.length < PAGE_SIZE) break;
  }

  const active = artifacts.filter((artifact) => !artifact.expired);
  active.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const runIds = [...new Set(active.map((artifact) => artifact.workflow_run && artifact.workflow_run.id).filter(Boolean))];
  return { active, runIds };
}

async function resolveMetadata(repo, env, runIds, options = {}) {
  const maxRunDetailLookups = options.maxRunDetailLookups || MAX_RUN_DETAIL_LOOKUPS;
  const maxJobLookups = options.maxJobLookups || MAX_JOB_LOOKUPS;
  const useRestFallback = options.useRestFallback !== false;

  const runInfo = new Map();
  const needDetail = [];
  await Promise.all(runIds.map(async (id) => {
    const cached = await cacheGet(runMetaKey(repo, id));
    if (cached) {
      try {
        const data = await cached.json();
        if (typeof data.buildType === 'string' && data.buildType && Array.isArray(data.pullRequests)) {
          runInfo.set(id, data);
          return;
        }
      } catch {}
    }
    needDetail.push(id);
  }));

  const runPuts = [];
  const needJobs = [];
  await Promise.all(needDetail.slice(0, maxRunDetailLookups).map(async (id) => {
    try {
      const response = await githubFetch(env, `/repos/${repo}/actions/runs/${id}`);
      if (!response.ok) return;
      const run = await response.json();
      const pullRequests = (run.pull_requests || []).map((pr) => pr.number).filter(Boolean);
      const buildType = detectBuildType([run.name, run.display_title]);
      if (buildType) {
        runInfo.set(id, { buildType, pullRequests });
        runPuts.push(cachePutJson(runMetaKey(repo, id), { buildType, pullRequests }));
      } else {
        needJobs.push({ id, pullRequests });
      }
    } catch {}
  }));

  await Promise.all(needJobs.slice(0, maxJobLookups).map(async ({ id, pullRequests }) => {
    try {
      const response = await githubFetch(env, `/repos/${repo}/actions/runs/${id}/jobs?per_page=${PAGE_SIZE}`);
      if (!response.ok) return;
      const data = await response.json();
      const candidates = [];
      for (const job of data.jobs || []) {
        candidates.push(job.name);
        for (const step of job.steps || []) candidates.push(step.name);
      }
      const buildType = detectBuildType(candidates) || 'Unknown';
      runInfo.set(id, { buildType, pullRequests });
      runPuts.push(cachePutJson(runMetaKey(repo, id), { buildType, pullRequests }));
    } catch {}
  }));
  await Promise.all(runPuts);

  const [owner, name] = repo.split('/');
  const prNumbers = [...new Set([...runInfo.values()].flatMap((info) => info.pullRequests))];
  const titles = new Map();
  const missingNumbers = [];
  await Promise.all(prNumbers.map(async (number) => {
    const cached = await cacheGet(prTitleKey(repo, number));
    if (cached) {
      try {
        const data = await cached.json();
        if (data.title) titles.set(number, data.title);
        return;
      } catch {}
    }
    missingNumbers.push(number);
  }));

  if (missingNumbers.length && isSafeRepoPart(owner) && isSafeRepoPart(name)) {
    const limited = missingNumbers.slice(0, MAX_PR_TITLE_LOOKUPS);
    const titlePuts = [];
    const result = await fetchPullRequestTitles(env, owner, name, limited);
    for (const [number, title] of result.titles) {
      titles.set(number, title);
      titlePuts.push(cachePutJson(prTitleKey(repo, number), { title }));
    }
    if (!result.graphqlOk && useRestFallback) {
      const restTitles = await fetchPullRequestTitlesRest(env, repo, limited);
      for (const [number, title] of restTitles) {
        titles.set(number, title);
        titlePuts.push(cachePutJson(prTitleKey(repo, number), { title }));
      }
    }
    await Promise.all(titlePuts);
  }

  return { runInfo, titles };
}

function assembleArtifacts(context, runInfo, titles) {
  const { active } = context;
  return active.map((artifact) => {
    const run = artifact.workflow_run || {};
    const info = runInfo.get(run.id) || {};
    return {
      id: artifact.id,
      name: artifact.name,
      size_in_bytes: artifact.size_in_bytes,
      created_at: artifact.created_at,
      expires_at: artifact.expires_at,
      expired: artifact.expired,
      build_type: detectBuildTypeFromName(artifact.name) || info.buildType || 'Unknown',
      build_hash: extractBuildHash(artifact.name),
      workflow_run: run.id ? {
        id: run.id,
        head_branch: run.head_branch || '',
        head_sha: run.head_sha || ''
      } : null,
      pull_requests: (info.pullRequests || []).map((number) => ({ number, title: titles.get(number) || '' }))
    };
  });
}

async function buildArtifactList(repo, env) {
  const context = await fetchArtifactContext(repo, env);
  const { runInfo, titles } = await resolveMetadata(repo, env, context.runIds);
  return assembleArtifacts(context, runInfo, titles);
}

async function cacheList(repo, artifacts) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (!cache) return;
  const cacheKey = `https://artifacts-proxy.invalid/list/${repo.toLowerCase()}`;
  const cacheable = new Response(JSON.stringify({ repo, artifacts }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` }
  });
  await cache.put(cacheKey, cacheable);
}

async function listHandler(request, env, ctx, repo) {
  if (!isAllowed(repo, env)) {
    throw new HttpError(403, 'Repository is not allowed by this proxy');
  }
  if (!listLimiter.check(clientIp(request))) {
    const response = jsonResponse(request, env, { error: 'Too many list requests, slow down' }, 429, 0, { 'Retry-After': '60' });
    return response;
  }

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = `https://artifacts-proxy.invalid/list/${repo.toLowerCase()}`;
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      for (const [name, value] of corsHeaders(request, env)) headers.set(name, value);
      return new Response(request.method === 'HEAD' ? null : cached.body, { status: cached.status, headers });
    }
  }

  const artifacts = await buildArtifactList(repo, env);
  const response = jsonResponse(request, env, { repo, artifacts }, 200, CACHE_TTL_SECONDS);

  if (ctx && ctx.waitUntil) ctx.waitUntil(cacheList(repo, artifacts));

  return response;
}

function contentDisposition(name) {
  const raw = (name || 'artifact').replace(/\.zip$/i, '') || 'artifact';
  const ascii = raw.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'artifact';
  const encoded = encodeURIComponent(`${raw}.zip`).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}.zip"; filename*=UTF-8''${encoded}`;
}

async function downloadHandler(request, env, repo, artifactId) {
  if (!isAllowed(repo, env)) {
    throw new HttpError(403, 'Repository is not allowed by this proxy');
  }
  if (!/^\d+$/.test(artifactId)) {
    throw new HttpError(400, 'Invalid artifact id');
  }
  if (!downloadLimiter.check(clientIp(request))) {
    const response = jsonResponse(request, env, { error: 'Too many download requests, slow down' }, 429, 0, { 'Retry-After': '60' });
    return response;
  }

  const metaResponse = await githubFetch(env, `/repos/${repo}/actions/artifacts/${artifactId}`);
  if (metaResponse.status === 404) {
    throw new HttpError(404, 'Artifact not found');
  }
  if (!metaResponse.ok) {
    throw new HttpError(502, await githubErrorMessage(metaResponse, 'load the artifact'));
  }

  const artifact = await metaResponse.json();
  if (artifact.expired) {
    throw new HttpError(410, 'Artifact has expired');
  }

  let zipResponse = await fetch(artifact.archive_download_url, {
    headers: githubHeaders(env),
    redirect: 'manual'
  });

  if (zipResponse.status >= 300 && zipResponse.status < 400) {
    const location = zipResponse.headers.get('Location');
    if (!location) throw new HttpError(502, 'GitHub did not return a download location');
    zipResponse = await fetch(location);
  }

  if (!zipResponse.ok) {
    throw new HttpError(502, `GitHub download failed (${zipResponse.status})`);
  }

  const headers = baseHeaders(request, env, 'application/zip');
  headers.set('Content-Disposition', contentDisposition(artifact.name));
  headers.set('Cache-Control', 'no-store');
  const length = zipResponse.headers.get('Content-Length');
  if (length) headers.set('Content-Length', length);

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(zipResponse.body, { status: 200, headers });
}

export default {
  async scheduled(event, env) {
    for (const repo of allowlist(env)) {
      try {
        const context = await fetchArtifactContext(repo, env);
        const { runInfo, titles } = await resolveMetadata(repo, env, context.runIds, {
          maxRunDetailLookups: MAX_RUN_DETAIL_LOOKUPS_CRON,
          maxJobLookups: MAX_JOB_LOOKUPS_CRON,
          useRestFallback: false
        });
        await cacheList(repo, assembleArtifacts(context, runInfo, titles));
      } catch (error) {
        console.error(`scheduled refresh failed for ${repo}:`, error);
      }
    }
  },
  async fetch(request, env, ctx) {
    try {
      if (request.method === 'OPTIONS') return preflight(request, env);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed');
      }

      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);

      if (parts.length === 1 && parts[0] === 'health') {
        return jsonResponse(request, env, { ok: true });
      }

      if (parts[0] === 'api' && parts[1] === 'artifacts' && parts.length === 4) {
        const repo = `${parts[2]}/${parts[3]}`;
        return await listHandler(request, env, ctx, repo);
      }

      if (parts[0] === 'download' && parts.length === 4) {
        const repo = `${parts[1]}/${parts[2]}`;
        return await downloadHandler(request, env, repo, parts[3]);
      }

      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Internal proxy error';
      if (status >= 500 && !(error instanceof HttpError)) console.error(error);
      return jsonResponse(request, env, { error: message }, status);
    }
  }
};

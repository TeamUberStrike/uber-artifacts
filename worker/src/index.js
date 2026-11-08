const GITHUB_API = 'https://api.github.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_RUN_LOOKUPS = 15;
const MAX_PR_LOOKUPS = 10;
const MAX_JOB_LOOKUPS = 15;
const CACHE_VERSION = '4';
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
    headers.set('Vary', 'Origin');
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

function jsonResponse(request, env, body, status = 200, cacheSeconds = 0) {
  const headers = baseHeaders(request, env, 'application/json; charset=utf-8');
  headers.set('Cache-Control', cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store');
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

function extractBuildHash(name) {
  const match = /([0-9a-f]{40})$/i.exec(name || '');
  return match ? match[1].toLowerCase() : '';
}

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

async function loadRunDetails(repo, artifacts, env) {
  const ids = [];
  const seen = new Set();
  for (const artifact of artifacts) {
    const id = artifact.workflow_run && artifact.workflow_run.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_RUN_LOOKUPS) break;
  }

  const map = new Map();
  await Promise.all(ids.map(async (id, index) => {
    const details = { pullRequests: [], buildType: '' };
    const requests = [githubFetch(env, `/repos/${repo}/actions/runs/${id}`)];
    if (index < MAX_JOB_LOOKUPS) {
      requests.push(githubFetch(env, `/repos/${repo}/actions/runs/${id}/jobs?per_page=100`));
    }
    const [runResponse, jobsResponse] = await Promise.all(requests.map((promise) => promise.catch(() => null)));
    const candidates = [];

    if (runResponse && runResponse.ok) {
      try {
        const run = await runResponse.json();
        details.pullRequests = (run.pull_requests || []).map((pr) => ({ number: pr.number }));
        candidates.push(run.name, run.display_title);
      } catch {}
    }

    if (jobsResponse && jobsResponse.ok) {
      try {
        const data = await jobsResponse.json();
        for (const job of data.jobs || []) {
          candidates.push(job.name);
          for (const step of job.steps || []) candidates.push(step.name);
        }
      } catch {}
    }

    details.buildType = detectBuildType(candidates);
    map.set(id, details);
  }));

  const numbers = new Set();
  for (const details of map.values()) {
    for (const pr of details.pullRequests) numbers.add(pr.number);
  }

  const titles = new Map();
  await Promise.all([...numbers].slice(0, MAX_PR_LOOKUPS).map(async (number) => {
    try {
      const response = await githubFetch(env, `/repos/${repo}/pulls/${number}`);
      if (!response.ok) return;
      const pullRequest = await response.json();
      titles.set(number, pullRequest.title || '');
    } catch {}
  }));

  for (const details of map.values()) {
    details.pullRequests = details.pullRequests.map((pr) => ({ number: pr.number, title: titles.get(pr.number) || '' }));
  }
  return map;
}

async function buildArtifactList(repo, env) {
  const artifacts = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await githubFetch(env, `/repos/${repo}/actions/artifacts?per_page=${PAGE_SIZE}&page=${page}`);
    if (!response.ok) {
      throw new HttpError(response.status, await githubErrorMessage(response, 'list artifacts'));
    }
    const data = await response.json();
    const pageArtifacts = data.artifacts || [];
    artifacts.push(...pageArtifacts);
    if (pageArtifacts.length < PAGE_SIZE) break;
  }

  artifacts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const activeArtifacts = artifacts.filter((artifact) => !artifact.expired);
  const runDetails = await loadRunDetails(repo, activeArtifacts, env);

  return activeArtifacts.map((artifact) => {
    const run = artifact.workflow_run || null;
    const details = (run && runDetails.get(run.id)) || { pullRequests: [], buildType: '' };
    return {
      id: artifact.id,
      name: artifact.name,
      size_in_bytes: artifact.size_in_bytes,
      expired: artifact.expired,
      created_at: artifact.created_at,
      expires_at: artifact.expires_at,
      build_type: details.buildType || 'Unknown',
      build_hash: extractBuildHash(artifact.name),
      workflow_run: run ? {
        id: run.id,
        head_branch: run.head_branch,
        head_sha: run.head_sha
      } : null,
      pull_requests: details.pullRequests
    };
  });
}

async function listHandler(request, env, ctx, repo) {
  if (!isAllowed(repo, env)) {
    throw new HttpError(403, 'Repository is not allowed by this proxy');
  }

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const key = new Request(`https://artifacts-proxy.invalid/${CACHE_VERSION}/list/${repo.toLowerCase()}`, { method: 'GET' });
    const cached = await cache.match(key);
    if (cached) {
      const headers = new Headers(cached.headers);
      for (const [name, value] of corsHeaders(request, env)) headers.set(name, value);
      return new Response(request.method === 'HEAD' ? null : cached.body, { status: cached.status, headers });
    }
  }

  const artifacts = await buildArtifactList(repo, env);
  const response = jsonResponse(request, env, { repo, artifacts }, 200, CACHE_TTL_SECONDS);

  if (cache) {
    const key = new Request(`https://artifacts-proxy.invalid/${CACHE_VERSION}/list/${repo.toLowerCase()}`, { method: 'GET' });
    const cacheable = new Response(JSON.stringify({ repo, artifacts }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` }
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, cacheable));
  }

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

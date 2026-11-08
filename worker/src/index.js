const GITHUB_API = 'https://api.github.com';

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

function baseHeaders(contentType) {
  const headers = new Headers();
  if (contentType) headers.set('Content-Type', contentType);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return headers;
}

function jsonResponse(body, status = 200) {
  const headers = baseHeaders('application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
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

  const headers = baseHeaders('application/zip');
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
  async fetch(request, env) {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed');
      }

      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);

      if (parts.length === 1 && parts[0] === 'health') {
        return jsonResponse({ ok: true });
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
      return jsonResponse({ error: message }, status);
    }
  }
};

const config = window.ARTIFACTS_CONFIG || {};
const proxyBase = String(config.proxyBase || '').replace(/\/+$/, '');
const defaultRepo = config.defaultRepo || 'TeamUberStrike/uber-client-4-3-8';
const $ = (id) => document.getElementById(id);
const state = { repo: '', artifacts: [], buildFilter: '', branchFilter: '', error: false };
const downloadIcon = '<svg class="dl-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M7.47 10.78a.75.75 0 0 0 1.06 0l3.75-3.75a.75.75 0 0 0-1.06-1.06L8.75 8.44V1.75a.75.75 0 0 0-1.5 0v6.69L4.78 5.97a.75.75 0 0 0-1.06 1.06l3.75 3.75ZM3.75 13a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5Z"/></svg>';

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setStatus(message, isError) {
  $('status').textContent = message;
  $('status').classList.toggle('error', Boolean(isError));
}

function repoFromInput(value) {
  return value.trim()
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

const GITHUB_API = 'https://api.github.com';
const MAX_PAGES = 5;
const BUILD_TYPES = [
  ['Windows', ['windows', 'win64', 'win32', 'standalonewindows']],
  ['Android', ['android']],
  ['iOS', ['ios', 'iphone', 'ipad']],
  ['Linux', ['linux', 'standalonelinux']],
  ['macOS', ['macos', 'osx', 'mac os', 'standalonemacos']],
  ['WebGL', ['webgl']]
];

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

async function githubJson(path) {
  let response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, { headers: { Accept: 'application/vnd.github+json' } });
  } catch {
    throw new Error('Cannot reach the GitHub API.');
  }
  if (!response.ok) {
    let message = `GitHub API request failed (${response.status})`;
    if (response.status === 403) message += ' - anonymous rate limit is 60 requests/hour per IP';
    if (response.status === 404) message += ' - check the repository name';
    throw new Error(message);
  }
  return response.json();
}

async function fetchArtifacts(repo) {
  const artifacts = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await githubJson(`/repos/${repo}/actions/artifacts?per_page=100&page=${page}`);
    const pageArtifacts = data.artifacts || [];
    artifacts.push(...pageArtifacts);
    if (pageArtifacts.length < 100) break;
  }

  const active = artifacts.filter((artifact) => !artifact.expired);
  active.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const runIds = [...new Set(active.map((artifact) => artifact.workflow_run && artifact.workflow_run.id).filter(Boolean))];
  const runDetails = new Map();
  await Promise.all(runIds.map(async (id) => {
    const details = { pullRequests: [], buildType: '' };
    const [runResponse, jobsResponse] = await Promise.all([
      fetch(`${GITHUB_API}/repos/${repo}/actions/runs/${id}`, { headers: { Accept: 'application/vnd.github+json' } }).catch(() => null),
      fetch(`${GITHUB_API}/repos/${repo}/actions/runs/${id}/jobs?per_page=100`, { headers: { Accept: 'application/vnd.github+json' } }).catch(() => null)
    ]);
    const candidates = [];
    if (runResponse && runResponse.ok) {
      try {
        const run = await runResponse.json();
        details.pullRequests = (run.pull_requests || []).map((pr) => ({ number: pr.number, title: '' }));
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
    runDetails.set(id, details);
  }));

  const prNumbers = [...new Set([...runDetails.values()].flatMap((details) => details.pullRequests.map((pr) => pr.number)))];
  const prTitles = new Map();
  await Promise.all(prNumbers.map(async (number) => {
    try {
      const pr = await githubJson(`/repos/${repo}/pulls/${number}`);
      prTitles.set(number, pr.title || '');
    } catch {}
  }));

  return active.map((artifact) => {
    const run = artifact.workflow_run || {};
    const details = runDetails.get(run.id) || {};
    return {
      id: artifact.id,
      name: artifact.name,
      size_in_bytes: artifact.size_in_bytes,
      created_at: artifact.created_at,
      expires_at: artifact.expires_at,
      expired: artifact.expired,
      build_type: details.buildType || 'Unknown',
      build_hash: extractBuildHash(artifact.name),
      workflow_run: run.id ? {
        id: run.id,
        head_branch: run.head_branch || '',
        head_sha: run.head_sha || ''
      } : null,
      pull_requests: (details.pullRequests || []).map((pr) => ({ number: pr.number, title: prTitles.get(pr.number) || '' }))
    };
  });
}

function downloadUrl(artifact) {
  return `${proxyBase}/download/${state.repo}/${artifact.id}`;
}

function chip(kind, value, label, active) {
  return `<button type="button" class="chip${active ? ' active' : ''}" data-kind="${kind}" data-value="${esc(value)}" aria-pressed="${active ? 'true' : 'false'}">${esc(label)}</button>`;
}

function renderFilters(active) {
  const container = $('filters');
  if (!active.length) {
    container.hidden = true;
    $('build-filters').innerHTML = '';
    $('branch-filters').innerHTML = '';
    return;
  }
  container.hidden = false;

  const types = [...new Set(active.map((a) => a.build_type || 'Unknown'))].sort();
  const branchSet = new Set(['main']);
  for (const artifact of active) {
    const branch = artifact.workflow_run && artifact.workflow_run.head_branch;
    if (branch) branchSet.add(branch);
  }
  const branches = [...branchSet].sort((a, b) => a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b));

  if (state.buildFilter && !types.includes(state.buildFilter)) state.buildFilter = '';
  if (state.branchFilter && !branches.includes(state.branchFilter)) state.branchFilter = '';

  $('build-filters').innerHTML =
    '<span class="filter-label">Build</span>' +
    chip('build', '', 'All', state.buildFilter === '') +
    types.map((type) => chip('build', type, type, state.buildFilter === type)).join('');
  const otherBranches = branches.filter((branch) => branch !== 'main');
  const selectValue = state.branchFilter !== 'main' && otherBranches.includes(state.branchFilter) ? state.branchFilter : '';
  $('branch-filters').innerHTML =
    '<span class="filter-label">Branch</span>' +
    chip('branch', 'main', 'main', state.branchFilter === 'main') +
    (otherBranches.length
      ? '<select id="branch-select">' +
        '<option value="">All</option>' +
        otherBranches.map((branch) => `<option value="${esc(branch)}"${branch === selectValue ? ' selected' : ''}>${esc(branch)}</option>`).join('') +
        '</select>'
      : '');
}

function render() {
  const term = $('filter').value.trim().toLowerCase();
  const active = state.artifacts.filter((a) => !a.expired);
  const visible = active.filter((a) => {
    const run = a.workflow_run || {};
    if (state.buildFilter && (a.build_type || 'Unknown') !== state.buildFilter) return false;
    if (state.branchFilter && run.head_branch !== state.branchFilter) return false;
    if (!term) return true;
    const prText = (a.pull_requests || []).map((pr) => `#${pr.number} ${pr.title || ''}`).join(' ');
    return [a.name, run.head_branch, run.head_sha, a.build_type, prText].some((v) => (v || '').toLowerCase().includes(term));
  });

  renderFilters(active);

  $('rows').innerHTML = visible.map((a) => {
    const run = a.workflow_run || {};
    const buildHash = a.build_hash || run.head_sha || '';
    const shortSha = buildHash.slice(0, 7);
    const runLink = run.id ? `<a class="mono" href="https://github.com/${esc(state.repo)}/actions/runs/${run.id}" target="_blank" rel="noopener">#${run.id}</a>` : '<span class="muted">n/a</span>';
    const shaLink = shortSha && run.id ? `<a class="mono" href="https://github.com/${esc(state.repo)}/commit/${esc(buildHash)}" target="_blank" rel="noopener" title="${esc(buildHash)}">${esc(shortSha)}</a>` : `<span class="mono muted">${esc(shortSha)}</span>`;
    const branchLink = run.head_branch ? `<a class="mono" href="https://github.com/${esc(state.repo)}/tree/${esc(run.head_branch)}" target="_blank" rel="noopener">${esc(run.head_branch)}</a>` : '';
    const metaLine = run.id
      ? `run ${runLink}${shortSha ? ' \u00b7 ' + shaLink : ''}${branchLink ? ' \u00b7 ' + branchLink : ''}`
      : 'run n/a';
    const prs = (a.pull_requests || []).filter(Boolean);
    const prLine = prs.length
      ? `<div class="pr-line">${prs.map((pr) => {
          const label = pr.title ? `PR #${pr.number} \u00b7 ${esc(pr.title)}` : `PR #${pr.number}`;
          return `<a href="https://github.com/${esc(state.repo)}/pull/${pr.number}" target="_blank" rel="noopener">${label}</a>`;
        }).join('<br>')}</div>`
      : '';
    const url = downloadUrl(a);
    return `
      <tr>
        <td class="artifact-cell" data-label="Artifact">
          <div class="name"><a href="${esc(url)}" title="Download artifact">${esc(a.name)}${downloadIcon}</a> <span class="badge badge-${esc((a.build_type || 'Unknown').toLowerCase())}">${esc(a.build_type || 'Unknown')}</span></div>
          <div class="meta-line">${metaLine}</div>
          ${prLine}
        </td>
        <td class="muted" data-label="Size">${esc(fmtBytes(a.size_in_bytes))}</td>
        <td class="muted" data-label="Created">${esc(fmtDate(a.created_at))}</td>
        <td class="muted" data-label="Expires">${esc(fmtDate(a.expires_at))}</td>
      </tr>`;
  }).join('');

  const empty = $('empty');
  empty.hidden = state.error || visible.length !== 0 || active.length !== 0;
  $('empty-text').textContent = 'No artifacts available.';
  $('filter').disabled = active.length === 0;

  if (!state.error) {
    setStatus(visible.length === active.length
      ? `${active.length} artifact${active.length === 1 ? '' : 's'}`
      : `${visible.length} of ${active.length} artifacts`);
  }
}

async function load() {
  const repo = repoFromInput($('repo').value);
  const remember = $('remember').checked;

  if (!proxyBase || proxyBase.includes('YOUR-SUBDOMAIN')) {
    setStatus('Set proxyBase in config.js to your deployed Worker URL.', true);
    return;
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    setStatus('Enter a repository as owner/name.', true);
    return;
  }

  state.repo = repo;
  state.error = false;
  state.buildFilter = '';
  state.branchFilter = '';
  $('repo').value = repo;
  setStatus('Loading...');
  $('empty').hidden = true;

  if (remember) localStorage.setItem('ghArtifacts.repo', repo);
  else localStorage.removeItem('ghArtifacts.repo');

  try {
    state.artifacts = await fetchArtifacts(repo);
    render();
  } catch (error) {
    state.artifacts = [];
    state.error = true;
    render();
    setStatus(error.message, true);
  }
}

$('controls').addEventListener('submit', (event) => {
  event.preventDefault();
  load();
});

$('filter').addEventListener('input', render);

$('filters').addEventListener('click', (event) => {
  const button = event.target.closest('button.chip');
  if (!button) return;
  if (button.dataset.kind === 'build') state.buildFilter = button.dataset.value;
  else if (button.dataset.kind === 'branch') state.branchFilter = state.branchFilter === button.dataset.value ? '' : button.dataset.value;
  else return;
  render();
});

$('filters').addEventListener('change', (event) => {
  if (event.target.id !== 'branch-select') return;
  state.branchFilter = event.target.value;
  render();
});

const savedRepo = localStorage.getItem('ghArtifacts.repo');
$('repo').value = savedRepo || defaultRepo;
load();

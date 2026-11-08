const config = window.ARTIFACTS_CONFIG || {};
const proxyBase = String(config.proxyBase || '').replace(/\/+$/, '');
const defaultRepo = config.defaultRepo || 'TeamUberStrike/uber-client-4-3-8';
const $ = (id) => document.getElementById(id);
const state = { repo: '', artifacts: [], buildFilter: '', branchFilter: '', error: false };

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

async function fetchArtifacts(repo) {
  let response;
  try {
    response = await fetch(`${proxyBase}/api/artifacts/${repo}`, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('Cannot reach the artifact proxy. Check proxyBase in config.js and the Worker deployment.');
  }

  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    throw new Error((body && body.error) || `Proxy request failed (${response.status})`);
  }
  return (body && body.artifacts) || [];
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
  $('branch-filters').innerHTML =
    '<span class="filter-label">Branch</span>' +
    chip('branch', '', 'All', state.branchFilter === '') +
    branches.map((branch) => chip('branch', branch, branch, state.branchFilter === branch)).join('');
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
    const shortSha = run.head_sha ? run.head_sha.slice(0, 7) : '';
    const runLink = run.id ? `<a class="mono" href="https://github.com/${esc(state.repo)}/actions/runs/${run.id}" target="_blank" rel="noopener">#${run.id}</a>` : '<span class="muted">n/a</span>';
    const shaLink = shortSha && run.id ? `<a class="mono" href="https://github.com/${esc(state.repo)}/commit/${esc(run.head_sha)}" target="_blank" rel="noopener">${esc(shortSha)}</a>` : `<span class="mono muted">${esc(shortSha)}</span>`;
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
          <div class="name">${esc(a.name)}</div>
          <div class="muted mono">${run.id ? `run ${runLink}${shortSha ? ' \u00b7 ' + shaLink : ''}` : 'run n/a'}</div>
          ${prLine}
        </td>
        <td data-label="Branch">${run.head_branch ? `<a href="https://github.com/${esc(state.repo)}/tree/${esc(run.head_branch)}" target="_blank" rel="noopener">${esc(run.head_branch)}</a>` : '<span class="muted">n/a</span>'}</td>
        <td class="muted" data-label="Size">${esc(fmtBytes(a.size_in_bytes))}</td>
        <td class="muted" data-label="Created">${esc(fmtDate(a.created_at))}</td>
        <td class="muted" data-label="Expires">${esc(fmtDate(a.expires_at))}</td>
        <td class="actions-cell">
          <div class="actions">
            <button class="small" type="button" data-copy="${esc(url)}" title="Copy download link">Copy link</button>
            <a class="btn small" href="${esc(url)}">Download</a>
          </div>
        </td>
      </tr>`;
  }).join('');

  const empty = $('empty');
  empty.hidden = state.error || visible.length !== 0;
  empty.textContent = active.length === 0 ? 'No artifacts available.' : 'No artifacts match the current filters.';
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
  else if (button.dataset.kind === 'branch') state.branchFilter = button.dataset.value;
  else return;
  render();
});

$('rows').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-copy]');
  if (!button) return;
  const value = button.dataset.copy;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1200);
  } catch {
    setStatus('Copy failed; clipboard access was denied.', true);
  }
});

const savedRepo = localStorage.getItem('ghArtifacts.repo');
$('repo').value = savedRepo || defaultRepo;
load();

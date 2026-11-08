const config = window.ARTIFACTS_CONFIG || {};
const proxyBase = String(config.proxyBase || '').replace(/\/+$/, '');
const defaultRepo = config.defaultRepo || 'TeamUberStrike/uber-client-4-3-8';
const $ = (id) => document.getElementById(id);
const state = { repo: '', artifacts: [] };

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
  if (artifact.expired) return '';
  return `${proxyBase}/download/${state.repo}/${artifact.id}`;
}

function render() {
  const term = $('filter').value.trim().toLowerCase();
  const visible = state.artifacts.filter((a) => {
    if (!term) return true;
    const run = a.workflow_run || {};
    const prText = (a.pull_requests || []).map((pr) => `#${pr.number}`).join(' ');
    return [a.name, run.head_branch, run.head_sha, prText].some((v) => (v || '').toLowerCase().includes(term));
  });

  $('rows').innerHTML = visible.map((a) => {
    const run = a.workflow_run || {};
    const shortSha = run.head_sha ? run.head_sha.slice(0, 7) : '';
    const runLink = run.id ? `<a class="mono" href="https://github.com/${esc(state.repo)}/actions/runs/${run.id}" target="_blank" rel="noopener">#${run.id}</a>` : '<span class="muted">n/a</span>';
    const shaLink = shortSha && run.id ? `<a class="mono" href="https://github.com/${esc(state.repo)}/commit/${esc(run.head_sha)}" target="_blank" rel="noopener">${esc(shortSha)}</a>` : `<span class="mono muted">${esc(shortSha)}</span>`;
    const prs = (a.pull_requests || []).filter(Boolean);
    const prCell = prs.length
      ? prs.map((pr) => `<a class="mono" href="https://github.com/${esc(state.repo)}/pull/${pr.number}" target="_blank" rel="noopener">#${pr.number}</a>`).join(', ')
      : '<span class="muted">-</span>';
    const url = downloadUrl(a);
    const download = url
      ? `<a class="btn small" href="${esc(url)}">Download</a>`
      : `<span class="btn small disabled">Expired</span>`;
    const name = esc(a.name);
    return `
      <tr>
        <td><div class="name">${a.expired ? `<span class="expired">${name}</span>` : name}</div>
            <div class="muted mono">${run.id ? `run ${runLink}${shortSha ? ' \u00b7 ' + shaLink : ''}` : 'run n/a'}</div></td>
        <td>${run.head_branch ? `<a href="https://github.com/${esc(state.repo)}/tree/${esc(run.head_branch)}" target="_blank" rel="noopener">${esc(run.head_branch)}</a>` : '<span class="muted">n/a</span>'}</td>
        <td>${prCell}</td>
        <td>${shaLink}</td>
        <td class="muted">${esc(fmtBytes(a.size_in_bytes))}</td>
        <td class="muted">${esc(fmtDate(a.created_at))}</td>
        <td class="${a.expired ? 'expired' : 'muted'}">${esc(fmtDate(a.expires_at))}</td>
        <td>
          <div class="actions">
            <button class="small" type="button" data-copy="${esc(url)}" title="Copy download link" ${url ? '' : 'disabled'}>Copy link</button>
            ${download}
          </div>
        </td>
      </tr>`;
  }).join('');

  $('empty').hidden = visible.length !== 0;
  $('filter').disabled = state.artifacts.length === 0;
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
  $('repo').value = repo;
  setStatus('Loading...');
  $('empty').hidden = true;

  if (remember) localStorage.setItem('ghArtifacts.repo', repo);
  else localStorage.removeItem('ghArtifacts.repo');

  try {
    state.artifacts = await fetchArtifacts(repo);
    const active = state.artifacts.filter((a) => !a.expired).length;
    setStatus(`${state.artifacts.length} artifact${state.artifacts.length === 1 ? '' : 's'} (${active} active)`);
    render();
  } catch (error) {
    state.artifacts = [];
    render();
    setStatus(error.message, true);
  }
}

$('controls').addEventListener('submit', (event) => {
  event.preventDefault();
  load();
});

$('filter').addEventListener('input', render);

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

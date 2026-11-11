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

const TYPE_PATTERNS = [
  ['Windows', ['windows', 'win64', 'win32', 'standalonewindows']],
  ['Android', ['android']],
  ['iOS', ['ios', 'iphone', 'ipad']],
  ['Linux', ['linux', 'standalonelinux']],
  ['macOS', ['macos', 'osx', 'mac os', 'standalonemacos']],
  ['WebGL', ['webgl']]
];

function typeFromName(name) {
  const match = /^(?:[^\-_.]+[\-_.])?(windows|win64|win32|android|ios|iphone|ipad|linux|macos|osx|mac os|webgl|standalonewindows|standalonelinux|standalonemacos)(?=[\-_.])/i.exec(name || '');
  const token = match && match[1].toLowerCase();
  if (!token) return '';
  for (const [type, aliases] of TYPE_PATTERNS) {
    if (aliases.includes(token)) return type;
  }
  return '';
}

const PLATFORM_ORDER = ['Windows', 'Android', 'iOS', 'Linux', 'macOS', 'WebGL'];

function groupKey(artifact) {
  if (artifact.build_hash) return artifact.build_hash;
  const run = artifact.workflow_run || {};
  if (run.id) return `run-${run.id}`;
  return `artifact-${artifact.id}`;
}

function commonName(artifacts) {
  const cleaned = artifacts.map((a) => String(a.name || '')
    .replace(/\.zip$/i, '')
    .replace(/[0-9a-f]{40}$/i, '')
    .replace(/^([^\-_.]+[\-_.])?(?:windows|win64|win32|android|ios|iphone|ipad|linux|macos|osx|mac os|webgl|standalonewindows|standalonelinux|standalonemacos)(?=[\-_.])/i, '$1')
    .replace(/^[-_.]+/, '')
    .replace(/([-_.])\1+/g, '$1')
    .replace(/[-_.]+$/g, ''));
  let prefix = cleaned[0];
  for (const name of cleaned.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix.replace(/[-_.]+$/g, '');
}

function groupArtifacts(active) {
  const groups = [];
  const byKey = new Map();
  for (const artifact of active) {
    const key = groupKey(artifact);
    let group = byKey.get(key);
    if (!group) {
      group = { key, artifacts: [], prs: new Map() };
      byKey.set(key, group);
      groups.push(group);
    }
    group.artifacts.push(artifact);
    for (const pr of (artifact.pull_requests || [])) {
      if (pr.number && !group.prs.has(pr.number)) group.prs.set(pr.number, pr);
    }
  }
  for (const group of groups) {
    group.artifacts.sort((x, y) => {
      const ix = PLATFORM_ORDER.indexOf(x.build_type);
      const iy = PLATFORM_ORDER.indexOf(y.build_type);
      return (ix === -1 ? PLATFORM_ORDER.length : ix) - (iy === -1 ? PLATFORM_ORDER.length : iy);
    });
  }
  return groups;
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
  const groups = groupArtifacts(active);
  const visible = groups.filter((group) => {
    if (state.buildFilter && !group.artifacts.some((a) => (a.build_type || 'Unknown') === state.buildFilter)) return false;
    if (state.branchFilter && !group.artifacts.some((a) => (a.workflow_run || {}).head_branch === state.branchFilter)) return false;
    if (!term) return true;
    return group.artifacts.some((a) => {
      const run = a.workflow_run || {};
      const prText = (a.pull_requests || []).map((pr) => `#${pr.number} ${pr.title || ''}`).join(' ');
      return [a.name, run.head_branch, run.head_sha, a.build_type, prText].some((v) => (v || '').toLowerCase().includes(term));
    });
  });

  renderFilters(active);

  $('rows').innerHTML = visible.map((group) => {
    const artifacts = group.artifacts;
    const runInfos = new Map();
    for (const a of artifacts) {
      const run = a.workflow_run || {};
      if (run.id && !runInfos.has(run.id)) runInfos.set(run.id, run);
    }
    const runs = [...runInfos.values()];
    const hashed = artifacts.find((a) => a.build_hash);
    const hash = (/^[0-9a-f]{40}$/.test(group.key) ? group.key : '') || (hashed && hashed.build_hash) || '';
    const shortSha = hash.slice(0, 7);
    const branch = runs.find((run) => run.head_branch) || {};
    const branchName = branch.head_branch || '';
    const runUrl = (id) => `https://github.com/${esc(state.repo)}/actions/runs/${id}`;
    const shaLink = hash
      ? `<a class="mono" href="https://github.com/${esc(state.repo)}/commit/${esc(hash)}" target="_blank" rel="noopener" title="${esc(hash)}">${esc(shortSha)}</a>`
      : '';
    const branchLink = branchName
      ? `<a class="mono" href="https://github.com/${esc(state.repo)}/tree/${esc(branchName)}" target="_blank" rel="noopener">${esc(branchName)}</a>`
      : '';

    let metaLine;
    if (!runs.length) {
      metaLine = 'run n/a';
    } else if (runs.length === 1) {
      const runLink = `<a class="mono" href="${runUrl(runs[0].id)}" target="_blank" rel="noopener">#${runs[0].id}</a>`;
      metaLine = `run ${runLink}${hash ? ' \u00b7 ' + shaLink : ''}${branchLink ? ' \u00b7 ' + branchLink : ''}`;
    } else {
      const runLinks = runs.map((run) => `<a class="mono" href="${runUrl(run.id)}" target="_blank" rel="noopener">#${run.id}</a>`).join(' ');
      metaLine = `runs ${runLinks}${hash ? ' \u00b7 ' + shaLink : ''}${branchLink ? ' \u00b7 ' + branchLink : ''}`;
    }

    const prs = [...group.prs.values()];
    const prLine = prs.length
      ? `<div class="pr-line">${prs.map((pr) => {
          const label = pr.title ? `PR #${pr.number} \u00b7 ${esc(pr.title)}` : `PR #${pr.number}`;
          return `<a href="https://github.com/${esc(state.repo)}/pull/${pr.number}" target="_blank" rel="noopener">${label}</a>`;
        }).join('<br>')}</div>`
      : '';

    const typeCounts = new Map();
    for (const a of artifacts) {
      const type = a.build_type || 'Unknown';
      typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    }
    const markers = artifacts.map((a) => {
      const type = a.build_type || 'Unknown';
      const cls = type.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const label = typeCounts.get(type) > 1 ? `${esc(type)} \u00b7 ${esc(fmtBytes(a.size_in_bytes))}` : esc(type);
      return `<a class="variant variant-${cls}" href="${esc(downloadUrl(a))}" title="Download ${esc(type)} (${esc(fmtBytes(a.size_in_bytes))})">${label}${downloadIcon}</a>`;
    }).join('');

    const base = commonName(artifacts) || 'Build';
    const displayName = hash ? `${base}.${hash}` : base;
    const nameHtml = runs.length === 1
      ? `<a href="${runUrl(runs[0].id)}" target="_blank" rel="noopener" title="View workflow run">${esc(displayName)}</a>`
      : esc(displayName);

    const created = artifacts.map((a) => a.created_at).filter(Boolean).sort()[0] || '';
    const expires = artifacts.map((a) => a.expires_at).filter(Boolean).sort()[0] || '';

    return `
      <tr>
        <td class="artifact-cell" data-label="Artifact">
          <div class="name">${nameHtml}</div>
          <div class="meta-line">${metaLine}</div>
          ${prLine}
          <div class="variants">${markers}</div>
        </td>
        <td class="muted" data-label="Created">${esc(fmtDate(created))}</td>
        <td class="muted" data-label="Expires">${esc(fmtDate(expires))}</td>
      </tr>`;
  }).join('');

  const empty = $('empty');
  empty.hidden = state.error || visible.length !== 0 || groups.length !== 0;
  $('empty-text').textContent = 'No builds available.';
  $('filter').disabled = groups.length === 0;

  if (!state.error) {
    setStatus(visible.length === groups.length
      ? `${groups.length} build${groups.length === 1 ? '' : 's'}`
      : `${visible.length} of ${groups.length} builds`);
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
    state.artifacts = (await fetchArtifacts(repo)).map((artifact) => {
      const type = typeFromName(artifact.name);
      if (type) artifact.build_type = type;
      return artifact;
    });
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

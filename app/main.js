// DocuBrew app shell. Plain ES modules, no framework (docs/DECISIONS.md D-010).
import { api, connectLive } from './api.js';
import { createPreview } from './preview.js';
import { createOpenDialog, createNewDialog, el } from './dialogs.js';

const $ = (sel) => document.querySelector(sel);

const state = { workspace: '', brew: null, pages: 0, ms: 0 };

// ─── Preview ───
const preview = createPreview($('#canvas'), {
  onBusy: (busy) => $('#live').classList.toggle('is-busy', busy),
  onRendered: ({ pages, ms }) => {
    state.pages = pages;
    state.ms = ms;
    $('#error').hidden = true;
    renderMeta();
  },
  onError: (message) => {
    $('#error-text').textContent = message;
    $('#error').hidden = false;
  },
});

// ─── Rendering the chrome ───
function renderMeta() {
  const b = state.brew;
  if (!b) { $('#meta').textContent = ''; return; }
  const blend = b.blend ? `${b.blend.source} ${b.blend.version}` : 'no blend';
  $('#zoom-reset').textContent = `${Math.round(preview.zoom * 100)}%`;
  if (!state.pages) { $('#meta').textContent = `Rendering…  ·  ${blend}`; return; }
  $('#meta').replaceChildren(
    el('b', {}, `${state.pages} ${state.pages === 1 ? 'page' : 'pages'}`),
    `  ·  ${blend}  ·  rendered in ${state.ms} ms`
  );
  $('#zoom-reset').textContent = `${Math.round(preview.zoom * 100)}%`;
}

function renderBrewState() {
  const b = state.brew;
  $('#doc-title').textContent = b ? b.title : 'No Brew open';
  document.title = b ? `${b.title} — DocuBrew` : 'DocuBrew';
  $('#empty').hidden = Boolean(b);
  document.querySelectorAll('.needs-brew').forEach((btn) => (btn.disabled = !b));
  document.querySelectorAll('#brew-list li[data-path]').forEach((li) => li.classList.toggle('is-active', li.dataset.path === b?.path));
  renderMeta();
}

async function loadSidebar() {
  const [brews, blends] = await Promise.all([api.brews(), api.blends()]);
  $('#brew-list').replaceChildren(
    ...(brews.length
      ? brews.map((b) =>
          el('li', { 'data-path': b.path, title: b.path, onclick: () => openBrew(b.path) },
            el('span', { class: 'list-title' }, b.title),
            el('span', { class: 'list-sub' }, `${b.folder} · ${b.chapters} ${b.chapters === 1 ? 'chapter' : 'chapters'}`)))
      : [el('li', { class: 'list-empty' }, 'No Brews in the workspace yet.')])
  );
  $('#blend-list').replaceChildren(
    ...blends.map((b) => el('li', { title: b.description || '' },
      el('span', { class: 'list-title' }, b.name),
      el('span', { class: 'list-sub' }, `${b.id} · ${b.version}`)))
  );
  renderBrewState();
}

// ─── Actions ───
async function openBrew(path) {
  const info = await api.open(path);
  setBrew(info);
}

function setBrew(info) {
  const changed = info?.path !== state.brew?.path;
  state.brew = info;
  if (changed) {
    state.pages = 0;
    preview.clear();
  }
  renderBrewState();
  if (info) preview.refresh();
}

async function exportPdf() {
  if (!state.brew) return;
  const btn = $('#btn-export');
  btn.classList.add('is-busy');
  btn.textContent = 'Exporting…';
  try {
    const r = await api.exportPdf();
    toast([`Exported ${r.pages} pages in ${(r.ms / 1000).toFixed(1)} s. `, el('a', { href: r.url, target: '_blank' }, 'Open PDF')]);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.classList.remove('is-busy');
    btn.textContent = 'Export PDF';
  }
}

let toastTimer;
function toast(content, isError = false) {
  const t = $('#toast');
  t.replaceChildren(...[].concat(content));
  t.classList.toggle('is-error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 9000 : 6000);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('docubrew.theme', next); } catch {}
  preview.themeChanged();
}

// ─── Wire up ───
const openDialog = createOpenDialog({ workspace: () => state.workspace, onOpen: openBrew });
const newDialog = createNewDialog({
  onCreate: async (data) => {
    const info = await api.create(data);
    await loadSidebar();
    setBrew(info);
  },
});

$('#btn-new').onclick = () => newDialog.show();
$('#btn-open').onclick = () => openDialog.show();
$('#btn-export').onclick = exportPdf;
$('#btn-folder').onclick = () => api.reveal().catch((e) => toast(e.message, true));
$('#btn-code').onclick = () => api.reveal('code').catch((e) => toast(e.message, true));
$('#btn-theme').onclick = toggleTheme;
document.querySelector('[data-action="new"]').onclick = () => newDialog.show();
document.querySelector('[data-action="open"]').onclick = () => openDialog.show();

const zoomed = () => renderMeta();
$('#zoom-in').onclick = () => { preview.zoomIn(); zoomed(); };
$('#zoom-out').onclick = () => { preview.zoomOut(); zoomed(); };
$('#zoom-reset').onclick = () => { preview.zoomReset(); zoomed(); };
$('#zoom-fit').onclick = () => { preview.zoomFit(); zoomed(); };

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key.toLowerCase() === 'e') { e.preventDefault(); exportPdf(); }
  else if (e.key.toLowerCase() === 'o') { e.preventDefault(); openDialog.show(); }
  else if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newDialog.show(); }
  else if (e.key === '=' || e.key === '+') { e.preventDefault(); preview.zoomIn(); zoomed(); }
  else if (e.key === '-') { e.preventDefault(); preview.zoomOut(); zoomed(); }
  else if (e.key === '0') { e.preventDefault(); preview.zoomReset(); zoomed(); }
});

let wasConnected = false;
connectLive({
  onStatus: (up) => {
    $('#live').classList.toggle('is-live', up);
    $('#live-text').textContent = up ? 'Live' : 'Offline';
    if (up && wasConnected && state.brew) preview.refresh(); // catch up on anything missed while disconnected
    if (up) wasConnected = true;
  },
  onMessage: (msg) => {
    if (msg.type === 'changed') {
      preview.refresh();
      if (msg.files.some((f) => f === 'brew.yaml' || f.startsWith('content/'))) loadSidebar();
    } else if (msg.type === 'opened') {
      if (msg.brew.path !== state.brew?.path) setBrew(msg.brew);
    }
  },
});

// ─── Start ───
const initial = await api.state();
state.workspace = initial.workspace;
$('#workspace-path').textContent = initial.workspace;
await loadSidebar();
setBrew(initial.brew);

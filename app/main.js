// DocuBrew app shell. Plain ES modules, no framework (docs/DECISIONS.md D-010).
import { api, connectLive } from './api.js';
import { createPreview } from './preview.js';
import { createOpenDialog, createNewDialog, el } from './dialogs.js';
import { createEditor } from './editor.js';
import { createSession } from './session.js';
import { createInspector } from './inspector.js';

const $ = (sel) => document.querySelector(sel);
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  workspace: '',
  brew: null,
  pages: 0,
  ms: 0,
  files: null,
  dirty: new Set(),
  editorOn: store.get('docubrew.editor', '1') === '1',
  syncOn: store.get('docubrew.sync', '1') === '1',
};

// ─── Preview ───
const preview = createPreview($('#canvas'), {
  onBusy: (busy) => $('#live').classList.toggle('is-busy', busy),
  onRendered: ({ pages, ms }) => {
    state.pages = pages;
    state.ms = ms;
    $('#error').hidden = true;
    renderMeta();
    syncPreview(); // keep the preview where the editor is after each refresh
  },
  onError: (message) => {
    $('#error-text').textContent = message;
    $('#error').hidden = false;
  },
  onJump: ({ file, line }) => {
    if (!state.editorOn) setEditor(true);
    session.open(file, { line }).catch((e) => toast(e.message, true));
  },
  onDropFiles: (files, { file, afterLine }) => insertImages(files, file, afterLine),
  onDragHint: (show) => ($('#drop-hint').hidden = !show),
  onZoom: () => renderZoom(),
  onSelect: (info, opts) => inspector.show(info, opts),
  onInspectEnd: () => setInspecting(false),
});

function renderZoom() {
  $('#zoom-reset').textContent = `${Math.round(preview.zoom * 100)}%`;
  $('#zoom-fit').classList.toggle('is-on', preview.fit);
}

// ─── Editor ───
let syncSuppressed = false;
const editor = createEditor($('#editor-host'), {
  onChange: () => session.changed(),
  onSave: () => session.save(),
  onScroll: () => { if (!syncSuppressed) scheduleSync(); },
  onDropFiles: (files, line) => {
    const f = session.file;
    if (!f || !/\.md$/i.test(f.path)) return toast('Drop images into a chapter (.md) file.', true);
    insertImages(files, f.path, line);
  },
});

const session = createSession(editor, {
  status: (text, kind) => {
    const s = $('#editor-status');
    s.textContent = text;
    s.className = `editor-status ${kind}`;
  },
  dirty: (path, isDirty) => {
    if (isDirty) state.dirty.add(path); else state.dirty.delete(path);
    renderFiles();
  },
  conflict: (path) => {
    $('#conflict').hidden = !path;
    if (path) $('#conflict-file').textContent = path;
  },
  opened: (file) => {
    $('#editor-path').textContent = file.path;
    store.set(`docubrew.file:${state.brew?.path}`, file.path);
    renderFiles();
    syncPreview();
  },
  error: (msg) => toast(msg, true),
});

const inspector = createInspector({
  preview,
  session,
  onJump: ({ file, line }) => {
    if (!state.editorOn) setEditor(true);
    session.open(file, { line }).catch((e) => toast(e.message, true));
  },
  onOpenFile: (path) => openInEditor(path),
  onClose: () => { preview.clearSelection(); },
  toast: (m, e) => toast(m, e),
});

function setInspecting(on) {
  state.inspecting = on;
  preview.setInspecting(on);
  $('#btn-inspect').classList.toggle('is-on', on);
  $('#inspect-hint').hidden = !on;
  if (on) setTimeout(() => { if (state.inspecting) $('#inspect-hint').hidden = true; }, 3500);
}
$('#btn-inspect').onclick = () => setInspecting(!state.inspecting);

$('#conflict-disk').onclick = () => session.resolve('disk');
$('#conflict-mine').onclick = () => session.resolve('mine');

// Editor → preview scroll sync
let syncFrame = 0;
function scheduleSync() {
  cancelAnimationFrame(syncFrame);
  syncFrame = requestAnimationFrame(syncPreview);
}
function syncPreview() {
  const f = session.file;
  if (!state.syncOn || !state.editorOn || !f || !/^content\/.+\.md$/i.test(f.path)) return;
  preview.scrollToSource(f.path, editor.topLine());
}

// ─── Images ───
const altFromPath = (p) => p.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

async function insertImages(files, file, afterLine) {
  const images = files.filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.name));
  if (!images.length) return toast('Only image files can be dropped.', true);
  if (!/\.md$/i.test(file)) return toast('Drop images into a chapter page.', true);
  try {
    const saved = [];
    for (const img of images) saved.push(await api.uploadImage(img));
    if (!state.editorOn) setEditor(true);
    await session.open(file);
    // Paths relative to content/, so VS Code's Markdown preview finds them too.
    const md = saved.map((s) => `![${altFromPath(s.path)}](../${s.path})`).join('\n\n');
    syncSuppressed = true;
    const line = editor.insertBlockAfter(afterLine, md);
    session.changed();
    await session.flush();
    editor.goToLine(line);
    syncSuppressed = false;
    toast(`${saved.length === 1 ? saved[0].path : `${saved.length} images`} added.`);
  } catch (err) {
    syncSuppressed = false;
    toast(err.message, true);
  }
}

// Never let a stray drop navigate the app away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ─── Sidebar: files ───
async function loadFiles() {
  if (!state.brew) { state.files = null; renderFiles(); return; }
  state.files = await api.files();
  renderFiles();
}

function fileItem(path, label = path) {
  const active = session.file?.path === path;
  return el('li', { class: active ? 'is-active' : '', title: path, onclick: () => openInEditor(path) },
    el('span', { class: 'file-name' }, label),
    state.dirty.has(path) ? el('span', { class: 'file-dirty', title: 'Unsaved' }) : null);
}

function renderFiles() {
  const f = state.files;
  $('#files').hidden = !f;
  if (!f) return;
  $('#file-list').replaceChildren(
    ...f.document.map((p) => fileItem(p)),
    el('li', { class: 'file-group' }, el('span', { class: 'label' }, 'Chapters')),
    ...(f.chapters.length ? f.chapters.map((p) => fileItem(p, p.replace(/^content\//, ''))) : [el('li', { class: 'list-empty' }, 'No chapters yet.')])
  );
  $('#blend-file-list').replaceChildren(...f.blend.map((p) => fileItem(p, p.replace(/^blend\//, ''))));
}

async function openInEditor(path) {
  if (!state.editorOn) setEditor(true);
  try { await session.open(path); } catch (e) { toast(e.message, true); }
}

$('#btn-add-chapter').onclick = () => {
  $('#new-chapter').hidden = false;
  $('#btn-add-chapter').hidden = true;
  $('#new-chapter').chapterTitle.focus();
};
$('#new-chapter').onsubmit = async (e) => {
  e.preventDefault();
  const input = e.target.chapterTitle;
  try {
    const { path } = await api.newChapter(input.value);
    input.value = '';
    closeNewChapter();
    await loadFiles();
    await openInEditor(path);
    editor.goToLine(4);
  } catch (err) { toast(err.message, true); }
};
$('#new-chapter').chapterTitle.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNewChapter(); });
$('#new-chapter').chapterTitle.addEventListener('blur', () => setTimeout(closeNewChapter, 150));
function closeNewChapter() {
  $('#new-chapter').hidden = true;
  $('#btn-add-chapter').hidden = false;
}

// ─── Editor visibility, sync toggle, resizing ───
function setEditor(on) {
  state.editorOn = on;
  store.set('docubrew.editor', on ? '1' : '0');
  renderLayout();
  if (on && !session.file && state.brew) openDefaultFile();
}
function renderLayout() {
  const show = state.editorOn && Boolean(state.brew);
  $('#editor-pane').hidden = !show;
  $('#resizer').hidden = !show;
  $('#work').classList.toggle('no-editor', !show);
  $('#btn-editor').classList.toggle('is-on', state.editorOn);
  $('#btn-sync').classList.toggle('is-on', state.syncOn);
  const w = store.get('docubrew.editorWidth', null);
  if (w) $('#work').style.setProperty('--editor-w', `${w}px`);
}
$('#btn-editor').onclick = () => setEditor(!state.editorOn);
$('#btn-sync').onclick = () => {
  state.syncOn = !state.syncOn;
  store.set('docubrew.sync', state.syncOn ? '1' : '0');
  renderLayout();
  syncPreview();
};

(function resizer() {
  const r = $('#resizer');
  const setWidth = (px) => {
    const work = $('#work').getBoundingClientRect();
    const w = Math.round(Math.min(Math.max(px, 280), work.width - 320));
    $('#work').style.setProperty('--editor-w', `${w}px`);
    store.set('docubrew.editorWidth', String(w));
  };
  r.addEventListener('pointerdown', (e) => {
    r.setPointerCapture(e.pointerId);
    r.classList.add('is-dragging');
    document.body.classList.add('is-resizing');
  });
  r.addEventListener('pointermove', (e) => {
    if (!r.hasPointerCapture(e.pointerId)) return;
    setWidth(e.clientX - $('#work').getBoundingClientRect().left);
  });
  r.addEventListener('pointerup', (e) => {
    r.releasePointerCapture(e.pointerId);
    r.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing');
  });
  r.addEventListener('keydown', (e) => {
    const cur = $('#editor-pane').getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') setWidth(cur - 24);
    if (e.key === 'ArrowRight') setWidth(cur + 24);
  });
})();

// ─── Chrome ───
function renderMeta() {
  const b = state.brew;
  if (!b) { $('#meta').textContent = ''; return; }
  const blend = b.blend ? `${b.blend.source} ${b.blend.version}` : 'no blend';
  renderZoom();
  if (!state.pages) { $('#meta').textContent = `Rendering…  ·  ${blend}`; return; }
  $('#meta').replaceChildren(
    el('b', {}, `${state.pages} ${state.pages === 1 ? 'page' : 'pages'}`),
    `  ·  ${blend}  ·  rendered in ${state.ms} ms`
  );
}

function renderBrewState() {
  const b = state.brew;
  $('#doc-title').textContent = b ? b.title : 'No Brew open';
  document.title = b ? `${b.title} — DocuBrew` : 'DocuBrew';
  $('#empty').hidden = Boolean(b);
  document.querySelectorAll('.needs-brew').forEach((btn) => (btn.disabled = !b));
  document.querySelectorAll('#brew-list li[data-path]').forEach((li) => li.classList.toggle('is-active', li.dataset.path === b?.path));
  renderMeta();
  renderLayout();
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
  await session.flush();
  const info = await api.open(path);
  await setBrew(info);
}

async function setBrew(info) {
  const changed = info?.path !== state.brew?.path;
  state.brew = info;
  if (changed) {
    state.pages = 0;
    state.dirty.clear();
    session.close();
    preview.clearSelection();
    preview.clear();
    setInspecting(false);
  }
  renderBrewState();
  if (!info) return;
  preview.refresh();
  if (changed) {
    await loadFiles();
    if (state.editorOn) await openDefaultFile();
  }
}

async function openDefaultFile() {
  const remembered = store.get(`docubrew.file:${state.brew?.path}`, null);
  const f = state.files;
  if (!f) return;
  const all = [...f.document, ...f.chapters, ...f.blend];
  const target = all.includes(remembered) ? remembered : f.chapters[0] || f.document[0];
  if (target) await openInEditor(target);
}

let exporting = false;
async function exportPdf() {
  if (!state.brew || exporting) return;
  exporting = true;
  const btn = $('#btn-export');
  btn.classList.add('is-busy');
  btn.textContent = 'Exporting…';
  // Open the tab now, while we're still inside the click — browsers block pop-ups opened later.
  const tab = store.get('docubrew.openPdf', '1') === '1' ? openWaitingTab(state.brew.title) : null;
  try {
    await session.flush();
    const r = await api.exportPdf();
    const url = `${r.url}?t=${Date.now()}`;
    if (tab && !tab.closed) tab.location.replace(url);
    notify({
      title: 'PDF exported',
      body: [`${r.pages} pages in ${(r.ms / 1000).toFixed(1)} s`, el('span', { class: 'toast-path', title: r.file }, r.file.split(/[\\/]/).slice(-3).join('/'))],
      actions: [
        el('button', { class: 'btn btn-toast', onclick: () => window.open(url, '_blank') }, 'Open PDF'),
        el('button', { class: 'btn btn-toast', onclick: () => api.reveal(null, r.file, true).catch((e) => toast(e.message, true)) }, 'Show in folder'),
      ],
      timeout: 15000,
    });
  } catch (err) {
    if (tab && !tab.closed) tab.close();
    notify({ title: 'Export failed', body: [err.message], error: true });
  } finally {
    exporting = false;
    btn.classList.remove('is-busy');
    btn.textContent = 'Export PDF';
  }
}

function openWaitingTab(title) {
  const tab = window.open('', '_blank');
  if (!tab) return null;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  tab.document.write(`<!doctype html><title>Exporting… — DocuBrew</title>
    <body style="margin:0;height:100vh;display:grid;place-items:center;background:#f8f7f4;color:#111;font:15px/1.4 Inter,system-ui,sans-serif">
    <div style="text-align:center"><div style="font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:#9b9a95">DocuBrew</div>
    <div style="font-size:22px;font-weight:700;letter-spacing:-.02em;margin-top:8px">Exporting ${esc(title)}…</div>
    <div style="color:#5f5e5a;margin-top:6px">The PDF opens here when it's ready.</div></div></body>`);
  tab.document.close();
  return tab;
}

/** A result card: title, body lines, actions. Errors stay until dismissed. */
let toastTimer;
function notify({ title, body = [], actions = [], error = false, timeout = 0 }) {
  const t = $('#toast');
  t.replaceChildren(
    el('div', { class: 'toast-main' },
      el('strong', { class: 'toast-title' }, title),
      ...body.map((b) => el('div', { class: 'toast-line' }, b))),
    el('div', { class: 'toast-actions' }, ...actions,
      el('button', { class: 'btn btn-toast btn-close', 'aria-label': 'Dismiss', onclick: () => (t.hidden = true) }, '×'))
  );
  t.classList.toggle('is-error', error);
  t.classList.add('is-card');
  t.hidden = false;
  clearTimeout(toastTimer);
  if (timeout) toastTimer = setTimeout(() => (t.hidden = true), timeout);
}

/** Short one-line message. */
function toast(content, isError = false) {
  const t = $('#toast');
  t.replaceChildren(...[].concat(content));
  t.classList.toggle('is-error', isError);
  t.classList.remove('is-card');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 9000 : 6000);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('docubrew.theme', next);
  preview.themeChanged();
}

// ─── Wire up ───
const openDialog = createOpenDialog({ workspace: () => state.workspace, onOpen: openBrew });
const newDialog = createNewDialog({
  onCreate: async (data) => {
    await session.flush();
    const info = await api.create(data);
    await loadSidebar();
    await setBrew(info);
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
  const typing = e.target.closest?.('.cm-editor, input, textarea, select, [contenteditable]');
  if (!mod) {
    if (e.key === 'Escape' && state.inspecting) setInspecting(false);
    else if (!typing && !e.altKey && e.key.toLowerCase() === 'i' && state.brew) setInspecting(!state.inspecting);
    return;
  }
  const k = e.key.toLowerCase();
  const inEditor = e.target.closest?.('.cm-editor');
  if (k === 'e') { e.preventDefault(); exportPdf(); }
  else if (k === 'o') { e.preventDefault(); openDialog.show(); }
  else if (k === 's') { e.preventDefault(); session.save(); }
  else if (k === '\\') { e.preventDefault(); setEditor(!state.editorOn); }
  else if (e.altKey && k === 'n') { e.preventDefault(); newDialog.show(); }
  else if (inEditor) return; // leave other shortcuts to the editor
  else if (e.key === '=' || e.key === '+') { e.preventDefault(); preview.zoomIn(); zoomed(); }
  else if (e.key === '-') { e.preventDefault(); preview.zoomOut(); zoomed(); }
  else if (e.key === '0') { e.preventDefault(); preview.zoomReset(); zoomed(); }
});

window.addEventListener('beforeunload', (e) => {
  if (session.dirty) { session.flush(); e.preventDefault(); }
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
      for (const f of msg.files) session.externalChange(f);
      if (msg.files.some((f) => f === 'brew.yaml' || f.startsWith('content/'))) loadSidebar();
      if (msg.files.some((f) => /^(content|images|blend)\//.test(f) || f === 'overrides.css')) loadFiles();
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
await setBrew(initial.brew);

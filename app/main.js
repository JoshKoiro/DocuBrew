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
  mode: 'brew',     // 'brew' | 'blend' (Blend Editor)
  brew: null,       // what's open: a Brew, or in Blend mode the Library Blend (both have path + title)
  lastBrew: null,   // for "Back to document"
  brews: [],
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
  getMode: () => state.mode,
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
  const brewFiles = files.filter((f) => /\.brew$/i.test(f.name));
  if (brewFiles.length) return importBrewFiles(brewFiles);
  if (state.mode !== 'brew') return toast('Images go into a Brew. Open a document to add them.', true);
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

// Never let a stray drop navigate the app away. A .brew dropped anywhere is imported.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.brew$/i.test(f.name));
  if (files.length) importBrewFiles(files);
});

// ─── .brew files ───
async function importBrewFiles(files) {
  for (const file of files) {
    try {
      await session.flush();
      const info = await api.importFile(file);
      await afterImport(info);
    } catch (err) {
      notify({ title: `Couldn't import ${file.name}`, body: [err.message], error: true });
    }
  }
}

async function afterImport(info) {
  await loadSidebar();
  await setBrew(info);
  notify({
    title: 'Brew imported',
    body: [info.title, el('span', { class: 'toast-path', title: info.path }, info.renamed ? `Saved as ${info.folder}/ (that name was taken)` : `${info.folder}/`)],
    actions: [el('button', { class: 'btn btn-toast', onclick: () => api.reveal(null, info.path).catch((e) => toast(e.message, true)) }, 'Show in folder')],
    timeout: 12000,
  });
}

async function exportBrew() {
  if (state.mode !== 'brew' || !state.brew) return;
  const btn = $('#btn-pack');
  btn.classList.add('is-busy');
  try {
    await session.flush();
    const r = await api.pack();
    const kb = r.bytes > 1024 * 1024 ? `${(r.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(r.bytes / 1024)} KB`;
    notify({
      title: '.brew exported',
      body: [`${r.files} files · ${kb} — content, images and its Blend, ready to send`, el('span', { class: 'toast-path', title: r.file }, r.file.split(/[\\/]/).slice(-3).join('/'))],
      actions: [
        el('button', { class: 'btn btn-toast', onclick: () => api.reveal(null, r.file, true).catch((e) => toast(e.message, true)) }, 'Show in folder'),
        el('a', { class: 'btn btn-toast', href: r.url, download: '', style: 'display:inline-grid;place-items:center;text-decoration:none' }, 'Download'),
      ],
      timeout: 15000,
    });
  } catch (err) {
    notify({ title: 'Export failed', body: [err.message], error: true });
  } finally {
    btn.classList.remove('is-busy');
  }
}
$('#btn-pack').onclick = exportBrew;

// ─── Check & AI context ───
async function runCheck() {
  if (state.mode !== 'brew' || !state.brew) return;
  const dlg = $('#dlg-check');
  $('#check-title').textContent = `Check — ${state.brew.title}`;
  $('#check-note').textContent = 'Checking…';
  $('#check-list').replaceChildren();
  if (!dlg.open) dlg.showModal();
  try {
    await session.flush();
    const r = await api.check();
    // Overflow comes from the rendered preview itself
    const overflow = preview.overflow().map((o) => ({
      severity: 'warning', file: o.file || 'content', line: o.line ? Number(o.line) : null,
      message: o.kind === 'tall' ? `${o.what} is taller than the page (page ${o.page}) and gets cut off.` : `${o.what} runs ${o.by} px past the page margin (page ${o.page}).`,
      hint: o.what === 'Image' || o.what === 'Figure' ? 'Give it a smaller width, e.g. {.fig-half}.' : 'Shorten it, reduce its font size, or set a width in overrides.css.',
    }));
    const problems = [...r.problems.filter((p) => p.severity === 'error'), ...overflow, ...r.problems.filter((p) => p.severity !== 'error')];
    const n = (sev) => problems.filter((p) => p.severity === sev).length;
    $('#btn-check').classList.toggle('has-errors', n('error') > 0);
    $('#check-note').textContent = problems.length
      ? [`${n('error')} error${n('error') === 1 ? '' : 's'}`, `${n('warning')} warning${n('warning') === 1 ? '' : 's'}`, `${n('info')} note${n('info') === 1 ? '' : 's'}`].join(' · ')
      : '';
    $('#check-list').replaceChildren(...(problems.length
      ? problems.map((p) => {
          const canOpen = p.file && /\.(md|ya?ml|css)$/i.test(p.file);
          return el('li', { class: canOpen ? 'is-link' : '', onclick: canOpen ? () => { dlg.close(); if (!state.editorOn) setEditor(true); session.open(p.file, { line: p.line || 1 }).catch((e) => toast(e.message, true)); } : null },
            el('span', { class: `check-sev sev-${p.severity}` }, p.severity === 'info' ? 'note' : p.severity),
            el('span', { class: 'check-where', title: `${p.file}${p.line ? `:${p.line}` : ''}` }, `${p.file}${p.line ? `:${p.line}` : ''}`),
            el('span', {}, p.message),
            p.hint ? el('span', { class: 'check-hint' }, p.hint) : null);
        })
      : [el('li', { class: 'check-ok', style: 'display:block' }, el('strong', {}, 'No problems found.'), `${state.pages} pages, nothing off the page, every image, variable and class accounted for.`)]));
  } catch (err) {
    $('#check-note').textContent = err.message;
  }
}
$('#btn-check').onclick = runCheck;
$('#check-again').onclick = runCheck;

async function copyAiContext() {
  if (state.mode !== 'brew' || !state.brew) return;
  try {
    await session.flush();
    const { text } = await api.context(true);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' }, text);
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const kb = Math.round(text.length / 1024);
    notify({
      title: 'AI context copied',
      body: [`About ${kb} KB (~${Math.round(text.length / 4 / 1000)}k tokens): this Brew's settings, its Blend's styles and variables, all chapters, current problems, and the DocuBrew guide.`, 'Paste it into Claude or any AI chat, then ask for what you want written.'],
      timeout: 12000,
    });
  } catch (err) { toast(err.message, true); }
}
$('#btn-ai').onclick = copyAiContext;

// ─── Sidebar: files ───
async function loadFiles() {
  if (!state.brew) { state.files = null; renderFiles(); return; }
  state.files = null;
  state.files = await api.files();
  renderFiles();
}

function fileItem({ path, label = path, readOnly, missing }) {
  const active = session.file?.path === path;
  return el('li', { class: `${active ? 'is-active' : ''} ${missing ? 'is-missing' : ''}`, title: readOnly ? `${path} (read-only)` : missing ? `${path} — not in this Blend yet; opening it starts one` : path, onclick: () => openInEditor(path) },
    el('span', { class: 'file-name' }, label),
    missing ? el('span', { class: 'file-note' }, 'empty') : null,
    state.dirty.has(path) ? el('span', { class: 'file-dirty', title: 'Unsaved' }) : null);
}

function renderFiles() {
  const f = state.files;
  $('#files').hidden = !f;
  if (!f) return;
  const open = f.groups.filter((g) => !g.collapsed);
  const folded = f.groups.find((g) => g.collapsed);
  $('#file-list').replaceChildren(
    ...open.flatMap((g) => [
      ...(g.label ? [el('li', { class: 'file-group' }, el('span', { class: 'label' }, g.label))] : []),
      ...(g.files.length ? g.files.map(fileItem) : [el('li', { class: 'list-empty' }, g.id === 'chapters' ? 'No chapters yet.' : 'None yet.')]),
    ])
  );
  $('#blend-files').hidden = !folded;
  if (folded) {
    $('#blend-files summary').textContent = folded.label;
    $('#blend-file-list').replaceChildren(...folded.files.map(fileItem));
  }
  $('#btn-add-chapter').hidden = state.mode !== 'brew' || !$('#new-chapter').hidden;
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
  $('#btn-add-chapter').hidden = state.mode !== 'brew';
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
  const blend = state.mode === 'blend' ? `${b.id} ${b.version}` : b.blend ? `${b.blend.source} ${b.blend.version}` : 'no blend';
  renderZoom();
  if (!state.pages) { $('#meta').textContent = `Rendering…  ·  ${blend}`; return; }
  $('#meta').replaceChildren(
    el('b', {}, `${state.pages} ${state.pages === 1 ? 'page' : 'pages'}`),
    `  ·  ${blend}  ·  rendered in ${state.ms} ms`
  );
}

function renderBrewState() {
  const b = state.brew;
  const blendMode = state.mode === 'blend';
  $('#doc-title').textContent = b ? (blendMode ? `${b.name} ${b.version}` : b.title) : 'No Brew open';
  document.title = b ? `${blendMode ? `${b.name} (Blend)` : b.title} — DocuBrew` : 'DocuBrew';
  document.body.classList.toggle('is-blend-mode', blendMode);
  $('#mode-tag').hidden = !blendMode;
  $('#btn-back').hidden = !blendMode || !state.lastBrew;
  document.querySelectorAll('.brew-only').forEach((n) => (n.hidden = blendMode));
  document.querySelectorAll('.blend-only').forEach((n) => (n.hidden = !blendMode));
  $('#empty').hidden = Boolean(b);
  document.querySelectorAll('.needs-brew').forEach((btn) => (btn.disabled = !b));
  document.querySelectorAll('#brew-list li[data-path]').forEach((li) => li.classList.toggle('is-active', !blendMode && li.dataset.path === b?.path));
  document.querySelectorAll('#blend-list li[data-id]').forEach((li) => li.classList.toggle('is-active', blendMode && li.dataset.id === b?.id));
  if (blendMode) renderPreviewWith();
  if (blendMode) $('#blend-banner').hidden = true;
  renderMeta();
  renderLayout();
}

async function loadSidebar() {
  const [brews, blends] = await Promise.all([api.brews(), api.allBlends()]);
  state.brews = brews;
  $('#brew-list').replaceChildren(
    ...(brews.length
      ? brews.map((b) =>
          el('li', { 'data-path': b.path, title: b.path, onclick: () => openBrew(b.path) },
            el('span', { class: 'list-title' }, b.title),
            el('span', { class: 'list-sub' }, `${b.folder} · ${b.chapters} ${b.chapters === 1 ? 'chapter' : 'chapters'}`)))
      : [el('li', { class: 'list-empty' }, 'No Brews in the workspace yet.')])
  );
  $('#blend-list').replaceChildren(
    ...blends.map((b) => el('li', { 'data-id': b.id, title: `${b.description || b.name}\nClick to open in the Blend Editor`, onclick: () => openBlend(b.id) },
      el('span', { class: 'list-title' }, b.name, b.abstract ? el('span', { class: 'list-tag' }, 'base') : null),
      el('span', { class: 'list-sub' }, `${b.id} · ${b.version}${b.extends ? ` · builds on ${b.extends}` : ''}`)))
  );
  renderBrewState();
}

// ─── Actions ───
async function openBrew(path) {
  await session.flush();
  const info = await api.open(path);
  await setBrew(info);
}

async function openBlend(id, previewWith) {
  await session.flush();
  const info = await api.openBlend(id, previewWith);
  await setBrew(info, 'blend');
}

async function setBrew(info, mode = 'brew') {
  const changed = info?.path !== state.brew?.path || mode !== state.mode;
  if (mode === 'brew' && info) { state.lastBrew = info.path; store.set('docubrew.lastBrew', info.path); }
  state.mode = mode;
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
  if (mode === 'brew') checkBlendStatus();
}

async function openDefaultFile() {
  const remembered = store.get(`docubrew.file:${state.brew?.path}`, null);
  const f = state.files;
  if (!f) return;
  const all = f.groups.flatMap((g) => g.files.map((x) => x.path));
  const target = all.includes(remembered) ? remembered : f.defaultFile;
  if (target) await openInEditor(target);
}

let exporting = false;
async function exportPdf() {
  if (!state.brew || exporting || state.mode !== 'brew') return;
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

// ─── Blend copy vs. Library (brew mode) ───
async function checkBlendStatus() {
  const banner = $('#blend-banner');
  banner.hidden = true;
  if (state.mode !== 'brew' || !state.brew) return;
  let s;
  try { s = await api.blendStatus(); } catch { return; }
  state.blendStatus = s;
  if (s.state === 'missing') {
    const key = `docubrew.dismiss:${state.brew.path}`;
    if (store.get(key, null) === `missing:${s.source}`) return;
    $('#blend-banner-text').textContent = `This Brew uses the Blend "${s.source}", which isn't in your Blend Library. It renders fine from its own copy — add it to your Library to reuse it.`;
    banner.querySelectorAll('.banner-actions .btn').forEach((b) => (b.hidden = !['blend-adopt', 'blend-dismiss'].includes(b.id)));
  } else if (s.state === 'out-of-date') {
    const key = `docubrew.dismiss:${state.brew.path}`;
    if (store.get(key, null) === s.libraryHash) return;
    const what = s.version === s.libraryVersion ? `${s.name} has changed in your Blend Library since this Brew copied it.` : `${s.name} ${s.libraryVersion} is in your Blend Library — this Brew uses ${s.version}.`;
    $('#blend-banner-text').textContent = `${what}${s.locallyModified ? ' This Brew\'s copy was also edited by hand; updating replaces those edits.' : ''}`;
    banner.querySelectorAll('.banner-actions .btn').forEach((b) => (b.hidden = b.id === 'blend-adopt'));
  } else return;
  if (state.mode === 'brew') banner.hidden = false;
}

async function updateBlend() {
  try {
    await session.flush();
    const s = await api.blendUpdate();
    $('#blend-banner').hidden = true;
    $('#dlg-diff').close();
    toast(`Updated to ${s.name} ${s.libraryVersion}. Your content and overrides.css were not changed.`);
    const info = await api.state();
    state.brew = info.brew;
    renderBrewState();
    loadFiles();
  } catch (err) { toast(err.message, true); }
}

async function reviewBlend() {
  const dlg = $('#dlg-diff');
  const s = state.blendStatus || {};
  $('#diff-note').replaceChildren(
    `Updating copies ${s.name || ''} ${s.libraryVersion || ''} from the Library into this Brew's blend/ folder.`,
    ...(s.locallyModified ? [' ', el('strong', {}, 'The copy was edited by hand — those edits are the red lines below.')] : [])
  );
  $('#diff-body').replaceChildren(el('p', { class: 'diff-empty' }, 'Comparing…'));
  dlg.showModal();
  try {
    const d = await api.blendDiff();
    $('#diff-body').replaceChildren(
      ...(d.files.length
        ? d.files.map((f, i) => el('details', { class: 'diff-file', open: i < 3 },
            el('summary', {}, el('span', { class: 'diff-status' }, f.status), f.path),
            f.binary ? el('p', { class: 'diff-empty' }, 'Binary file (e.g. a font) — contents differ.') : patchView(f.patch)))
        : [el('p', { class: 'diff-empty' }, 'No differences in the files — only the recorded version differs.')])
    );
  } catch (err) {
    $('#diff-body').replaceChildren(el('p', { class: 'diff-empty' }, err.message));
  }
}

function patchView(patch) {
  const lines = patch.split('\n').slice(4); // skip the ===/---/+++ header
  return el('pre', {}, ...lines.filter((l) => l !== '\\ No newline at end of file').map((l) => el('span', {
    class: `diff-line ${l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : l.startsWith('@@') ? 'diff-hunk' : ''}`,
  }, l || ' ')));
}

$('#blend-review').onclick = reviewBlend;
$('#blend-update').onclick = updateBlend;
$('#diff-update').onclick = updateBlend;
$('#blend-adopt').onclick = async () => {
  try {
    const r = await api.adoptBlend();
    $('#blend-banner').hidden = true;
    await loadSidebar();
    toast(`Added ${r.blend.name} to your Blend Library.`);
  } catch (err) { toast(err.message, true); }
};
$('#blend-dismiss').onclick = () => {
  const s = state.blendStatus;
  if (s?.state === 'missing') store.set(`docubrew.dismiss:${state.brew.path}`, `missing:${s.source}`);
  else if (s?.libraryHash) store.set(`docubrew.dismiss:${state.brew.path}`, s.libraryHash);
  $('#blend-banner').hidden = true;
};

// ─── Blend Editor ───
function renderPreviewWith() {
  const sel = $('#preview-with');
  const current = state.brew?.previewWith || 'specimen';
  sel.replaceChildren(
    el('option', { value: 'specimen' }, 'Specimen (every element)'),
    ...state.brews.map((b) => el('option', { value: b.path }, b.title))
  );
  sel.value = current;
}
$('#preview-with').onchange = async (e) => {
  try { await setBrew(await api.previewWith(e.target.value), 'blend'); preview.refresh(); } catch (err) { toast(err.message, true); }
};

async function refreshBlendInfo() {
  const info = await api.state();
  if (info.mode === 'blend') { state.brew = info.blend; renderBrewState(); }
}

$('#btn-back').onclick = () => state.lastBrew && openBrew(state.lastBrew).catch((e) => toast(e.message, true));

// New Blend
const newBlendForm = $('#new-blend-form');
$('#btn-new-blend').onclick = async () => {
  newBlendForm.reset();
  $('#new-blend-error').hidden = true;
  const blends = await api.allBlends();
  newBlendForm.elements.namedItem('blendExtends').replaceChildren(
    ...blends.map((b) => el('option', { value: b.id, selected: b.abstract }, `${b.name} (${b.id})`)),
    el('option', { value: '' }, 'Nothing — start from scratch')
  );
  $('#dlg-new-blend').showModal();
  newBlendForm.elements.namedItem('blendName').focus();
};
$('#dlg-new-blend [data-close]').onclick = () => $('#dlg-new-blend').close();
newBlendForm.onsubmit = async (e) => {
  e.preventDefault();
  const f = newBlendForm.elements;
  try {
    const info = await api.createBlend({ name: f.namedItem('blendName').value, extends: f.namedItem('blendExtends').value || null, description: f.namedItem('blendDescription').value });
    $('#dlg-new-blend').close();
    await loadSidebar();
    await setBrew(info, 'blend');
  } catch (err) {
    $('#new-blend-error').textContent = err.message;
    $('#new-blend-error').hidden = false;
  }
};

// Release version
const releaseForm = $('#release-form');
$('#btn-release').onclick = () => {
  const v = (state.brew?.version || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  const options = [
    ['patch', `${v[0]}.${v[1]}.${v[2] + 1}`, 'Fix — small corrections that don\'t change the look'],
    ['minor', `${v[0]}.${v[1] + 1}.0`, 'Change — adjusts the look; documents may re-flow'],
    ['major', `${v[0] + 1}.0.0`, 'Redesign — documents will look different'],
  ];
  $('#release-picks').replaceChildren(...options.map(([bump, version, desc], i) =>
    el('label', { class: 'blend-pick' },
      el('input', { type: 'radio', name: 'bump', value: bump, checked: i === 1 }),
      el('span', { class: 'blend-pick-name' }, version),
      el('span', { class: 'blend-pick-desc' }, desc))));
  releaseForm.elements.namedItem('releaseNote').value = '';
  $('#release-error').hidden = true;
  $('#dlg-release').showModal();
};
$('#dlg-release [data-close]').onclick = () => $('#dlg-release').close();
releaseForm.onsubmit = async (e) => {
  e.preventDefault();
  try {
    await session.flush();
    const bump = releaseForm.querySelector('input[name="bump"]:checked')?.value || 'minor';
    const r = await api.releaseBlend({ bump, note: releaseForm.elements.namedItem('releaseNote').value });
    $('#dlg-release').close();
    state.brew = r.blend;
    renderBrewState();
    loadSidebar();
    toast(`Released ${r.blend.name} ${r.version}. Brews using it will offer the update.`);
  } catch (err) {
    $('#release-error').textContent = err.message;
    $('#release-error').hidden = false;
  }
};

// Samples
$('#btn-samples').onclick = async () => {
  try {
    const added = await api.samples();
    await loadSidebar();
    toast(added.length ? `Added ${added.map((b) => b.title).join(', ')}.` : 'All sample Brews are already in your workspace.');
  } catch (err) { toast(err.message, true); }
};

// ─── Wire up ───
const openDialog = createOpenDialog({
  workspace: () => state.workspace,
  onOpen: openBrew,
  onImport: async (path) => { await session.flush(); await afterImport(await api.importPath(path)); },
});
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
      if (state.mode === 'blend' || msg.files.some((f) => /^(content|images|blend)\//.test(f) || f === 'overrides.css')) loadFiles();
      if (state.mode === 'blend' && msg.files.includes('blend.yaml')) refreshBlendInfo();
    } else if (msg.type === 'opened') {
      const info = msg.mode === 'blend' ? msg.blend : msg.brew;
      if (info.path !== state.brew?.path || msg.mode !== state.mode) setBrew(info, msg.mode);
    }
  },
});

// ─── Start ───
const initial = await api.state();
state.workspace = initial.workspace;
state.lastBrew = store.get('docubrew.lastBrew', null);
$('#workspace-path').textContent = initial.workspace;
await loadSidebar();
if (initial.mode === 'blend') await setBrew(initial.blend, 'blend');
else await setBrew(initial.brew);

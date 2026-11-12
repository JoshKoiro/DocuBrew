// Finding and managing Brews: the All Brews table (GitHub #5), delete to trash (GitHub #4),
// and the Ctrl+K quick switcher.
import { api } from './api.js';
import { el } from './dialogs.js';

const $ = (sel) => document.querySelector(sel);

// ─── Fuzzy matching ───

/**
 * Score `text` against `query` (letters in order, not necessarily adjacent).
 * Returns null for no match, else { score, hits } where hits are matched character indexes.
 * Runs of adjacent letters and letters at word starts score higher.
 */
export function fuzzy(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, hits: [] };
  const t = String(text || '');
  const lower = t.toLowerCase();
  // An exact substring beats any scattered match.
  const at = lower.indexOf(query.toLowerCase().trim());
  if (at >= 0 && query.trim()) {
    const n = query.trim().length;
    return { score: 1000 - at + (at === 0 || /[\s\-_/.]/.test(t[at - 1]) ? 200 : 0), hits: Array.from({ length: n }, (_, i) => at + i) };
  }
  const hits = [];
  let score = 0;
  let prev = -2;
  let i = 0;
  for (const ch of q) {
    const found = lower.indexOf(ch, i);
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s\-_/.]/.test(t[found - 1]);
    score += 10 + (found === prev + 1 ? 15 : 0) + (wordStart ? 12 : 0) - Math.min(found - i, 10);
    hits.push(found);
    prev = found;
    i = found + 1;
  }
  return { score, hits };
}

/** Best match over several fields; the first field (the title) counts most. */
function matchItem(query, fields) {
  let best = null;
  fields.forEach((f, idx) => {
    const m = fuzzy(query, f);
    if (m && (!best || m.score - idx * 40 > best.score)) best = { score: m.score - idx * 40, field: idx, hits: m.hits };
  });
  return best;
}

function highlight(text, hits) {
  if (!hits?.length) return [text];
  const set = new Set(hits);
  const out = [];
  let run = '';
  let inHit = false;
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== inHit && run) { out.push(inHit ? el('mark', {}, run) : run); run = ''; }
    inHit = h;
    run += text[i];
  }
  if (run) out.push(inHit ? el('mark', {}, run) : run);
  return out;
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'Yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A button that asks "Sure?" on the first click and acts on the second. */
function confirmButton(label, confirmLabel, action, extra = {}) {
  let armed = false;
  let timer;
  const btn = el('button', {
    type: 'button',
    class: 'btn btn-quiet btn-danger',
    ...extra,
    onclick: (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        btn.textContent = confirmLabel;
        timer = setTimeout(() => { armed = false; btn.textContent = label; }, 3500);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      action();
    },
  }, label);
  return btn;
}

// ─── All Brews ───

export function createBrewBrowser({ current, onOpen, onOpenTab, beforeDelete, onDeleted, onRestored, toast }) {
  const dlg = $('#dlg-brews');
  const search = $('#brews-search');
  let brews = [];
  let trash = [];
  let showTrash = false;
  let sort = { key: 'modified', dir: -1 };
  let focus = -1;
  let rows = [];

  const columns = () => showTrash
    ? [['title', 'Title'], ['folder', 'Folder'], ['deletedAt', 'Deleted'], [null, '']]
    : [['title', 'Title'], ['blend', 'Blend'], ['chapters', 'Chapters'], ['modified', 'Modified'], ['editingBy', 'Editing'], [null, '']];

  const sortValue = (b, key) => {
    if (key === 'blend') return b.blend ? `${b.blend.source} ${b.blend.version}` : '';
    if (key === 'chapters') return b.chapters ?? 0;
    return b[key] ?? '';
  };

  async function load() {
    try {
      [brews, trash] = await Promise.all([api.brews(), api.trash()]);
    } catch (err) {
      toast(err.message, true);
    }
    render();
  }

  function render() {
    $('#brews-heading').textContent = showTrash ? 'Trash' : 'Brews';
    $('#brews-trash-toggle').textContent = showTrash ? '← Brews' : `Trash${trash.length ? ` (${trash.length})` : ''}`;
    $('#brews-hint').textContent = showTrash
      ? 'Deleted Brews stay here until you delete them forever. Restoring puts the folder back in the workspace.'
      : 'Click a row to open it here. Ctrl+click or ↗ opens it in a new tab.';
    search.placeholder = showTrash ? 'Search the trash…' : 'Search title, folder, Blend…';

    $('#brews-head').replaceChildren(...columns().map(([key, label]) => el('th', {
      class: `${key ? '' : 'no-sort'} ${sort.key === key ? 'is-sorted' : ''} ${key === 'chapters' ? 't-num' : ''}`,
      onclick: key ? () => { sort = { key, dir: sort.key === key ? -sort.dir : key === 'modified' || key === 'deletedAt' ? -1 : 1 }; render(); } : null,
    }, label, sort.key === key ? (sort.dir > 0 ? ' ↑' : ' ↓') : '')));

    const q = search.value.trim();
    const source = showTrash ? trash : brews;
    let items = source.map((b) => ({ b, m: q ? matchItem(q, [b.title, b.folder, b.blend ? b.blend.source : '', b.subtitle || '']) : null }));
    if (q) items = items.filter((x) => x.m).sort((a, b) => b.m.score - a.m.score);
    else {
      const key = showTrash && !['title', 'folder', 'deletedAt'].includes(sort.key) ? 'deletedAt' : sort.key;
      items.sort((a, b) => {
        const va = sortValue(a.b, key);
        const vb = sortValue(b.b, key);
        return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sort.dir;
      });
    }
    rows = items.map((x) => x.b);
    focus = Math.min(focus, rows.length - 1);
    $('#brews-count').textContent = q ? `${rows.length} of ${source.length}` : `${source.length} ${showTrash ? 'in trash' : source.length === 1 ? 'Brew' : 'Brews'}`;

    const body = items.map(({ b, m }, i) => (showTrash ? trashRow(b, m, i) : brewRow(b, m, i)));
    if (!body.length) {
      body.push(el('tr', { class: 'brews-empty' }, el('td', { colspan: columns().length },
        q ? 'Nothing matches.' : showTrash ? 'The trash is empty.' : 'No Brews in the workspace yet.')));
    }
    $('#brews-body').replaceChildren(...body);
  }

  function brewRow(b, m, i) {
    const cur = current();
    const titleHits = m?.field === 0 ? m.hits : null;
    const folderHits = m?.field === 1 ? m.hits : null;
    return el('tr', {
      class: `${b.path === cur ? 'is-current' : ''} ${i === focus ? 'is-focus' : ''}`,
      title: b.path,
      onclick: (e) => pick(b, e.ctrlKey || e.metaKey || e.shiftKey),
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); pick(b, true); } },
    },
      el('td', {}, el('span', { class: 't-title' }, ...highlight(b.title, titleHits)), el('span', { class: 't-sub' }, ...highlight(b.folder, folderHits))),
      el('td', { class: 't-dim' }, b.blend ? `${b.blend.source} ${b.blend.version}` : '—'),
      el('td', { class: 't-num t-dim' }, String(b.chapters ?? '—')),
      el('td', { class: 't-dim', title: b.modified ? new Date(b.modified).toLocaleString() : '' }, timeAgo(b.modified)),
      el('td', { class: b.editingBy ? 't-editing' : 't-dim' }, b.editingBy || ''),
      el('td', { class: 't-actions' },
        el('button', { type: 'button', class: 'btn btn-quiet', title: 'Open in a new tab', onclick: (e) => { e.stopPropagation(); pick(b, true); } }, '↗ New tab'),
        b.editingBy
          ? el('button', { type: 'button', class: 'btn btn-quiet', disabled: true, title: `${b.editingBy} is editing it` }, 'Delete')
          : confirmButton('Delete', 'Move to trash?', () => remove(b), { title: 'Move this Brew to the trash (you can restore it)' })));
  }

  function trashRow(t, m, i) {
    return el('tr', { class: i === focus ? 'is-focus' : '', title: t.original, onclick: null, style: 'cursor:default' },
      el('td', {}, el('span', { class: 't-title' }, ...highlight(t.title, m?.field === 0 ? m.hits : null))),
      el('td', { class: 't-dim' }, ...highlight(t.folder, m?.field === 1 ? m.hits : null)),
      el('td', { class: 't-dim', title: new Date(t.deletedAt).toLocaleString() }, timeAgo(t.deletedAt)),
      el('td', { class: 't-actions' },
        el('button', { type: 'button', class: 'btn btn-quiet', onclick: (e) => { e.stopPropagation(); restore(t); } }, 'Restore'),
        confirmButton('Delete forever', 'Really? Can\'t undo', () => purge(t))));
  }

  function pick(b, newTab) {
    if (newTab) return onOpenTab(b.path);
    dlg.close();
    onOpen(b.path);
  }

  async function remove(b) {
    try {
      await beforeDelete?.(b);
      const meta = await api.deleteBrew(b.path);
      await load();
      onDeleted(meta, b);
    } catch (err) {
      toast(err.message, true);
      render();
    }
  }

  async function restore(t) {
    try {
      const info = await api.restoreTrash(t.id);
      await load();
      onRestored(info);
    } catch (err) { toast(err.message, true); }
  }

  async function purge(t) {
    try {
      await api.purgeTrash(t.id);
      await load();
    } catch (err) { toast(err.message, true); }
  }

  search.addEventListener('input', () => { focus = 0; render(); });
  search.addEventListener('keydown', (e) => {
    if (showTrash) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focus = Math.max(0, Math.min(rows.length - 1, focus + (e.key === 'ArrowDown' ? 1 : -1)));
      render();
      $('#brews-body tr.is-focus')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const b = rows[Math.max(focus, 0)];
      if (b) pick(b, e.ctrlKey || e.metaKey || e.shiftKey);
    }
  });
  $('#brews-trash-toggle').onclick = () => { showTrash = !showTrash; focus = -1; render(); search.focus(); };

  return {
    async show({ trash: t = false } = {}) {
      showTrash = t;
      search.value = '';
      focus = -1;
      brews = brews.length ? brews : [];
      render();
      if (!dlg.open) dlg.showModal();
      search.focus();
      await load();
    },
    refresh: () => { if (dlg.open) load(); },
  };
}

// ─── Quick switcher ───

export function createPalette({ items, onPick }) {
  const dlg = $('#dlg-palette');
  const input = $('#palette-input');
  const list = $('#palette-list');
  let all = [];
  let shown = [];
  let focus = 0;

  function render() {
    const q = input.value.trim();
    let scored = all.map((it) => ({ it, m: q ? matchItem(q, [it.title, it.sub]) : { score: it.recent || 0, field: -1, hits: [] } }));
    if (q) scored = scored.filter((x) => x.m);
    scored.sort((a, b) => b.m.score - a.m.score || a.it.title.localeCompare(b.it.title));
    shown = scored.slice(0, 50);
    focus = Math.max(0, Math.min(focus, shown.length - 1));
    list.replaceChildren(...(shown.length
      ? shown.map(({ it, m }, i) => el('li', {
          class: i === focus ? 'is-focus' : '',
          role: 'option',
          onmousemove: () => { if (focus !== i) { focus = i; mark(); } },
          onclick: (e) => choose(i, e.ctrlKey || e.metaKey || e.shiftKey),
        },
          el('span', {}, el('span', { class: 'p-title' }, ...highlight(it.title, m.field === 0 ? m.hits : null)), el('span', { class: 'p-sub' }, ...highlight(it.sub, m.field === 1 ? m.hits : null))),
          el('span', { class: 'p-kind' }, it.kind)))
      : [el('li', { class: 'p-empty' }, 'Nothing matches.')]));
  }
  function mark() {
    [...list.children].forEach((li, i) => li.classList.toggle('is-focus', i === focus));
    list.children[focus]?.scrollIntoView({ block: 'nearest' });
  }
  function choose(i, newTab) {
    const x = shown[i];
    if (!x) return;
    dlg.close();
    onPick(x.it, newTab);
  }

  input.addEventListener('input', () => { focus = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focus = Math.max(0, Math.min(shown.length - 1, focus + (e.key === 'ArrowDown' ? 1 : -1)));
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(focus, e.ctrlKey || e.metaKey || e.shiftKey);
    }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click on the backdrop

  return {
    async show() {
      if (dlg.open) return dlg.close();
      input.value = '';
      focus = 0;
      all = [];
      render();
      dlg.showModal();
      input.focus();
      try { all = await items(); } catch {}
      render();
    },
  };
}

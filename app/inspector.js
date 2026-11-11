// The inspector panel: Blend presets, a few properties, and where edits are written.
//
// Presets add a class to the Markdown ({.fig-right}) — no CSS, so documents stay consistent.
// Properties write a rule to the managed section of overrides.css, for either
//   "This element"  →  #id   (DocuBrew adds {#id} to the Markdown the first time)
//   "All <kind>"     →  an element selector (figure, p, h2, .callout-warning …)
import { api } from './api.js';
import { el } from './dialogs.js';

const ATTR_KINDS = ['heading', 'paragraph', 'figure', 'list', 'table'];
const NO_TEXT = ['figure', 'rule'];
const HAS_WIDTH = ['figure', 'table', 'callout', 'code', 'quote', 'template', 'other'];

const PROPS = [
  { prop: 'width', label: 'Width', type: 'percent', when: (k) => HAS_WIDTH.includes(k) },
  { prop: 'font-size', label: 'Text size', type: 'pt', step: 0.5, when: (k) => !NO_TEXT.includes(k) },
  { prop: 'font-weight', label: 'Weight', type: 'select', options: [['', '—'], ['400', 'Regular'], ['600', 'Semibold'], ['700', 'Bold']], when: (k) => !NO_TEXT.includes(k) },
  { prop: 'text-align', label: 'Align', type: 'seg', options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']], when: (k) => !NO_TEXT.includes(k) },
  { prop: 'color', label: 'Color', type: 'color', when: (k) => !NO_TEXT.includes(k) },
  { prop: 'margin-top', label: 'Space above', type: 'pt', step: 1, when: () => true },
  { prop: 'margin-bottom', label: 'Space below', type: 'pt', step: 1, when: () => true },
];
const PAGE = [
  { prop: 'break-before', value: 'page', label: 'Start on a new page' },
  { prop: 'break-after', value: 'avoid', label: 'Keep with next' },
];

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const PREFIX = { figure: 'fig', heading: 'h', paragraph: 'p', list: 'list', table: 'table' };

// In the Blend Editor, which layer file a kind of element is written to by default.
const DEFAULT_LAYER = { callout: 'components.css', template: 'templates.css' };
const LAYERS = [['tokens.css', 'tokens'], ['base.css', 'base'], ['components.css', 'components'], ['page.css', 'page'], ['templates.css', 'templates']];

export function createInspector({ preview, session, onJump, onOpenFile, onClose, toast, getMode }) {
  const root = document.querySelector('#inspector');
  const body = document.querySelector('#insp-body');
  let info = null;
  let scope = 'this';
  let decls = {};
  let presets = {};
  let controls = new Map();
  let pending = {};
  let timer = null;
  let selectorCache = null;
  let layerFile = null; // Blend Editor only
  const blendMode = () => getMode() === 'blend';
  const file = () => (blendMode() ? layerFile : undefined);

  document.querySelector('#insp-close').onclick = () => onClose();
  document.querySelector('#insp-where').onclick = () => info?.line && onJump({ file: info.file, line: info.line });

  async function loadPresets() {
    try { presets = await api.presets(); } catch { presets = {}; }
  }

  const canThis = () => !blendMode() && Boolean(info && (ATTR_KINDS.includes(info.kind) && /^content\//.test(info.file || '') || info.id));

  function selector() {
    if (scope === 'all') return info.all;
    return info.id ? `#${CSS.escape(info.id)}` : null;
  }

  async function ensureSelector() {
    const s = selector();
    if (s) return s;
    // First edit to "this element": give it a readable id in the Markdown.
    const base = `${PREFIX[info.kind] || 'el'}-${slug(info.kind === 'figure' ? info.text.split('/').pop().replace(/\.[^.]+$/, '') : info.text.split(/\s+/).slice(0, 4).join(' ')) || 'item'}`.slice(0, 40).replace(/-+$/, '');
    let id = base;
    for (let i = 2; preview.idExists(id); i++) id = `${base}-${i}`;
    await session.flush();
    await api.setAttrs({ file: info.file, line: info.line, end: info.end, kind: info.kind, id });
    info.id = id;
    preview.tagSelected({ id });
    renderHeader();
    return `#${CSS.escape(id)}`;
  }

  async function show(next, { refreshed = false } = {}) {
    if (!next) { info = null; root.hidden = true; return; }
    const same = refreshed && info && next.key?.file === info.key?.file;
    info = next;
    root.hidden = false;
    // A new selection always starts at "This element" — carrying "All …" over would silently
    // restyle every element of the next kind you click.
    if (!same) {
      scope = canThis() ? 'this' : 'all';
      layerFile = DEFAULT_LAYER[next.kind] || 'base.css';
    }
    else if (!canThis()) scope = 'all';
    renderHeader();
    if (!same) {
      await loadPresets();
      build();
    }
    await loadDecls();
  }

  async function loadDecls() {
    const s = selector();
    selectorCache = s;
    decls = {};
    if (s) {
      try { decls = (await api.getStyle(s, file())).decls; } catch {}
    }
    if (selectorCache !== s) return; // selection changed meanwhile
    update();
  }

  function renderHeader() {
    document.querySelector('#insp-kind').textContent = info.label + (info.id ? `  #${info.id}` : '');
    const where = document.querySelector('#insp-where');
    where.textContent = info.file ? `${info.file}${info.line ? `:${info.line}` : ''}` : '';
    where.disabled = !info.line;
  }

  // ── Build the panel for the current selection ─────────────────────────────
  function build() {
    controls = new Map();
    const sections = [];

    // Scope
    const thisOk = canThis();
    if (blendMode()) {
      const sel = el('select', { class: 'select', onchange: () => { layerFile = sel.value; build(); loadDecls(); } },
        ...LAYERS.map(([f, label]) => el('option', { value: f, selected: f === layerFile }, label)));
      sections.push(section('Applies to',
        el('p', { class: 'insp-note' }, `${info.allLabel} — in every document that uses this Blend.`),
        el('div', { class: 'prop' }, el('span', { class: 'prop-label' }, 'Write to'), el('div', { class: 'prop-control' }, sel), el('span'))));
    } else sections.push(section('Applies to',
      seg([['this', 'This element'], ['all', info.allLabel]], scope, (v) => { scope = v; loadDecls(); }, { disabled: thisOk ? [] : ['this'], key: 'scope' }),
      thisOk ? null : el('p', { class: 'insp-note' }, info.kind === 'template' ? 'Template elements are styled by class.' : 'This kind of block can only be styled as a group.')
    ));

    // Presets from the Blend
    const list = presets[info.kind] || [];
    if (!blendMode() && list.length && ATTR_KINDS.includes(info.kind) && /^content\//.test(info.file || '')) {
      const chips = el('div', { class: 'chips' },
        chip('None', null),
        ...list.map((p) => chip(p.label || p.class, p.class)));
      controls.set('presets', chips);
      sections.push(section('Blend style', el('p', { class: 'insp-note' }, 'Named styles from the Blend — the consistent choice.'), chips));
    }

    // Properties
    const rows = PROPS.filter((p) => p.when(info.kind)).map(propRow);
    sections.push(section('Properties', ...rows));

    // Page
    sections.push(section('Page', ...PAGE.map((p) => {
      const input = el('input', { type: 'checkbox', onchange: () => setProp(p.prop, input.checked ? p.value : null) });
      controls.set(p.prop, { input, page: p });
      return el('label', { class: 'check' }, input, p.label);
    })));

    // Rule preview
    const pre = el('pre', { class: 'rule-preview' });
    controls.set('rule', pre);
    const target = blendMode() ? layerFile : 'overrides.css';
    sections.push(section(`Written to ${target}`, pre,
      el('div', { class: 'chips' },
        el('button', { class: 'insp-link', onclick: () => onOpenFile(blendMode() ? layerFile : 'overrides.css') }, `Open ${target}`),
        el('button', { class: 'insp-link', onclick: resetAll }, 'Reset all'))));

    body.replaceChildren(...sections);
  }

  function section(title, ...children) {
    return el('div', { class: 'insp-section' }, el('p', { class: 'label' }, title), ...children);
  }

  function seg(options, value, onPick, { disabled = [], key } = {}) {
    const wrap = el('div', { class: 'seg', role: 'group' });
    for (const [v, label] of options) {
      wrap.append(el('button', { type: 'button', 'data-v': v, class: v === value ? 'is-on' : '', disabled: disabled.includes(v), onclick: () => {
        wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === v));
        onPick(v);
      } }, label));
    }
    if (key) controls.set(key, wrap);
    return wrap;
  }

  function chip(label, cls) {
    return el('button', { class: 'chip', 'data-class': cls || '', onclick: () => applyPreset(cls) }, label);
  }

  function propRow(def) {
    const reset = el('button', { class: 'prop-reset', title: 'Reset', 'aria-label': `Reset ${def.label}`, onclick: () => setProp(def.prop, null) }, '×');
    let control;
    let set;
    if (def.type === 'percent') {
      const num = el('input', { type: 'number', min: 5, max: 100, step: 1 });
      const range = el('input', { type: 'range', min: 5, max: 100, step: 1 });
      num.oninput = () => { range.value = num.value; setProp(def.prop, num.value ? `${num.value}%` : null); };
      range.oninput = () => { num.value = range.value; setProp(def.prop, `${range.value}%`); };
      control = el('div', { class: 'prop-control' }, range, num, el('span', { class: 'unit' }, '%'));
      set = (v, placeholder) => { num.value = v ? parseFloat(v) : ''; num.placeholder = parseFloat(placeholder) || ''; range.value = parseFloat(v || placeholder) || 100; };
      controls.set(def.prop, { row: null, set, focusables: [num, range] });
    } else if (def.type === 'pt') {
      const num = el('input', { type: 'number', min: 0, max: 200, step: def.step });
      num.oninput = () => setProp(def.prop, num.value === '' ? null : `${num.value}pt`);
      control = el('div', { class: 'prop-control' }, num, el('span', { class: 'unit' }, 'pt'));
      set = (v, placeholder) => { num.value = v ? parseFloat(v) : ''; num.placeholder = parseFloat(placeholder) || ''; };
      controls.set(def.prop, { set, focusables: [num] });
    } else if (def.type === 'select') {
      const sel = el('select', { onchange: () => setProp(def.prop, sel.value || null) }, ...def.options.map(([v, l]) => el('option', { value: v }, l)));
      control = el('div', { class: 'prop-control' }, sel);
      set = (v, placeholder) => { sel.value = v || ''; sel.options[0].textContent = placeholder ? `— (${placeholder})` : '—'; };
      controls.set(def.prop, { set, focusables: [sel] });
    } else if (def.type === 'seg') {
      const s = seg(def.options, null, (v) => setProp(def.prop, decls[def.prop] === v ? null : v));
      control = el('div', { class: 'prop-control' }, s);
      set = (v) => s.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === v));
      controls.set(def.prop, { set, focusables: [] });
    } else if (def.type === 'color') {
      const color = el('input', { type: 'color' });
      const text = el('input', { type: 'text', spellcheck: 'false' });
      color.oninput = () => { text.value = color.value; setProp(def.prop, color.value); };
      text.onchange = () => setProp(def.prop, text.value.trim() || null);
      control = el('div', { class: 'prop-control' }, color, text);
      set = (v, placeholder) => { text.value = v || ''; text.placeholder = placeholder || ''; color.value = /^#[0-9a-f]{6}$/i.test(v || placeholder) ? (v || placeholder) : '#111111'; };
      controls.set(def.prop, { set, focusables: [text, color] });
    }
    const row = el('div', { class: 'prop' }, el('span', { class: 'prop-label' }, def.label), control, reset);
    controls.get(def.prop).row = row;
    return row;
  }

  // ── Refresh values without rebuilding (keeps focus while typing) ──────────
  function update() {
    if (!info) return;
    const scopeSeg = controls.get('scope');
    scopeSeg?.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === scope));
    const chips = controls.get('presets');
    if (chips) {
      const names = (presets[info.kind] || []).map((p) => p.class);
      const active = names.find((c) => info.classes.includes(c)) || '';
      chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-on', c.dataset.class === active));
    }
    for (const def of PROPS) {
      const c = controls.get(def.prop);
      if (!c) continue;
      const value = decls[def.prop] || '';
      c.row.classList.toggle('is-set', Boolean(value));
      if (!c.focusables.includes(document.activeElement)) c.set(value, info.computed[def.prop]);
    }
    for (const p of PAGE) {
      const c = controls.get(p.prop);
      c.input.checked = decls[p.prop] === p.value;
    }
    renderRule();
  }

  function renderRule() {
    const pre = controls.get('rule');
    if (!pre) return;
    const s = selector() || `#${PREFIX[info.kind] || 'el'}-…`;
    const entries = Object.entries(decls).filter(([, v]) => v);
    pre.textContent = entries.length ? `${s} {\n${entries.map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}` : `${s} { }\n(no changes yet)`;
  }

  // ── Writing ───────────────────────────────────────────────────────────────
  async function setProp(prop, value) {
    let s;
    try { s = await ensureSelector(); } catch (err) { toast(err.message, true); return; }
    if (value) decls[prop] = value; else delete decls[prop];
    pending[prop] = value || null;
    preview.liveStyle(s, { [prop]: value || '' });
    update();
    clearTimeout(timer);
    timer = setTimeout(() => flush(s), 350);
  }

  async function flush(s) {
    const set = pending;
    pending = {};
    if (!Object.keys(set).length) return;
    try {
      const r = await api.setStyle(s, set, file());
      if (selector() === s) { decls = r.decls; update(); }
    } catch (err) { toast(err.message, true); }
  }

  async function resetAll() {
    const s = selector();
    if (!s || !Object.keys(decls).length) return;
    const set = Object.fromEntries(Object.keys(decls).map((k) => [k, null]));
    preview.liveStyle(s, Object.fromEntries(Object.keys(decls).map((k) => [k, ''])));
    decls = {};
    update();
    try { await api.setStyle(s, set, file()); } catch (err) { toast(err.message, true); }
  }

  async function applyPreset(cls) {
    const all = (presets[info.kind] || []).map((p) => p.class);
    const remove = all.filter((c) => c !== cls);
    info.classes = [...info.classes.filter((c) => !remove.includes(c)), ...(cls ? [cls] : [])];
    preview.tagSelected({ addClasses: cls ? [cls] : [], removeClasses: remove }); // instant
    update();
    try {
      await session.flush();
      await api.setAttrs({ file: info.file, line: info.line, end: info.end, kind: info.kind, addClasses: cls ? [cls] : [], removeClasses: remove });
    } catch (err) { toast(err.message, true); }
  }

  return { show, get open() { return Boolean(info); } };
}

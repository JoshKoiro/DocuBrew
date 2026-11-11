// Inspect mode inside the preview document: hover outline, click to select, and describing
// what was picked (kind, source location, selectors, current computed values).

const KIND = {
  FIGURE: { kind: 'figure', label: 'Figure', all: 'figure', allLabel: 'All figures' },
  P: { kind: 'paragraph', label: 'Paragraph', all: 'p', allLabel: 'All paragraphs' },
  UL: { kind: 'list', label: 'List', all: 'ul', allLabel: 'All bulleted lists' },
  OL: { kind: 'list', label: 'Numbered list', all: 'ol', allLabel: 'All numbered lists' },
  TABLE: { kind: 'table', label: 'Table', all: 'table', allLabel: 'All tables' },
  BLOCKQUOTE: { kind: 'quote', label: 'Quote', all: 'blockquote', allLabel: 'All quotes' },
  PRE: { kind: 'code', label: 'Code block', all: 'pre', allLabel: 'All code blocks' },
  LI: { kind: 'item', label: 'List item', all: 'li', allLabel: 'All list items' },
  HR: { kind: 'rule', label: 'Rule', all: 'hr', allLabel: 'All rules' },
};

const PAGED_INTERNAL = /^pagedjs_|^db-/;

/** Find the element the inspector should pick for a node under the pointer. */
export function pickElement(node) {
  let el = node?.nodeType === 1 ? node : node?.parentElement;
  if (!el) return null;
  const section = el.closest('[data-source-file]');
  if (!section) return null; // margins, page chrome
  const fig = el.closest('figure');
  if (fig && section.contains(fig)) return fig;
  const sourced = el.closest('[data-source-line]');
  if (sourced && section.contains(sourced)) return sourced;
  // Template output (title page, chapter opener): nearest element with a class of its own
  while (el && el !== section) {
    if ([...el.classList].some((c) => !PAGED_INTERNAL.test(c))) return el;
    el = el.parentElement;
  }
  return null;
}

/** Describe an element for the inspector panel. */
export function describe(el) {
  const section = el.closest('[data-source-file]');
  const tag = el.tagName;
  const ownClasses = [...el.classList].filter((c) => !PAGED_INTERNAL.test(c));
  let k;
  const fromTemplate = !el.dataset.sourceLine && tag !== 'FIGURE' && ownClasses.length > 0;
  if (fromTemplate) {
    k = { kind: 'template', label: `.${ownClasses[0]}`, all: `.${ownClasses[0]}`, allLabel: `All .${ownClasses[0]}` };
  } else if (/^H[1-6]$/.test(tag)) {
    const n = tag[1];
    k = { kind: 'heading', label: `Heading ${n}`, all: `h${n}`, allLabel: `All level-${n} headings` };
  } else if (tag === 'ASIDE' && el.classList.contains('callout')) {
    const type = ownClasses.find((c) => c.startsWith('callout-'))?.slice(8) || 'note';
    k = { kind: 'callout', label: `Callout · ${type}`, all: `.callout-${type}`, allLabel: `All ${type} callouts` };
  } else if (KIND[tag] && el.dataset.sourceLine) {
    k = KIND[tag];
  } else if (KIND[tag] && tag === 'FIGURE') {
    k = KIND.FIGURE;
  } else {
    const cls = ownClasses[0];
    k = cls
      ? { kind: 'template', label: `.${cls}`, all: `.${cls}`, allLabel: `All .${cls}` }
      : { kind: 'other', label: tag.toLowerCase(), all: tag.toLowerCase(), allLabel: `All <${tag.toLowerCase()}>` };
  }
  return {
    ...k,
    tag: tag.toLowerCase(),
    file: section?.dataset.sourceFile || null,
    line: el.dataset.sourceLine ? Number(el.dataset.sourceLine) : null,
    end: el.dataset.sourceEnd ? Number(el.dataset.sourceEnd) : null,
    id: el.id || null,
    classes: ownClasses,
    text: (el.querySelector('img')?.getAttribute('src') || el.textContent || '').trim().slice(0, 80),
    computed: computedFor(el),
    key: keyFor(el),
  };
}

/** A key to find "the same" element again after the preview re-renders. */
function keyFor(el) {
  const section = el.closest('[data-source-file]');
  if (el.dataset.sourceLine) return { file: section.dataset.sourceFile, line: el.dataset.sourceLine, tag: el.tagName };
  const cls = [...el.classList].find((c) => !PAGED_INTERNAL.test(c));
  const same = [...section.querySelectorAll(`.${CSS.escape(cls || '')}`)];
  return { file: section.dataset.sourceFile, cls, index: Math.max(0, same.indexOf(el)), tag: el.tagName };
}

export function findByKey(doc, key) {
  if (!key) return null;
  const sections = [...doc.querySelectorAll(`[data-source-file="${CSS.escape(key.file)}"]`)];
  for (const s of sections) {
    if (key.line) {
      const el = [...s.querySelectorAll(`[data-source-line="${key.line}"]`)].find((e) => e.tagName === key.tag);
      if (el) return el;
    }
  }
  if (key.cls) {
    const all = sections.flatMap((s) => [...s.querySelectorAll(`.${CSS.escape(key.cls)}`)]);
    return all[key.index] || null;
  }
  return null;
}

const PX_TO_PT = 0.75;
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function computedFor(el) {
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  const parent = el.parentElement;
  const pw = parent ? parent.getBoundingClientRect().width : 0;
  const w = el.getBoundingClientRect().width;
  return {
    width: pw ? `${Math.round((w / pw) * 100)}%` : '',
    'font-size': `${round(parseFloat(cs.fontSize) * PX_TO_PT)}pt`,
    'font-weight': cs.fontWeight,
    'text-align': cs.textAlign === 'start' ? 'left' : cs.textAlign,
    color: rgbToHex(cs.color),
    'margin-top': `${round(parseFloat(cs.marginTop) * PX_TO_PT)}pt`,
    'margin-bottom': `${round(parseFloat(cs.marginBottom) * PX_TO_PT)}pt`,
  };
}

function rgbToHex(rgb) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
  if (!m) return '';
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

/** Outline boxes drawn over the preview document (outside <body>, so zoom doesn't distort them). */
export function createOverlay(doc) {
  const mk = (css) => {
    const d = doc.createElement('div');
    d.setAttribute('style', `position:fixed;pointer-events:none;z-index:2147483646;display:none;box-sizing:border-box;${css}`);
    doc.documentElement.appendChild(d);
    return d;
  };
  const hover = mk('outline:1px dashed #e2231a;outline-offset:1px;background:rgba(226,35,26,.05);');
  const select = mk('outline:2px solid #e2231a;outline-offset:2px;');
  const tag = mk('background:#e2231a;color:#fff;font:600 10px/1 Inter,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:4px 6px;white-space:nowrap;');

  function place(box, el) {
    if (!el || !el.isConnected) { box.style.display = 'none'; return null; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    return r;
  }

  return {
    hover(el, label) {
      const r = place(hover, el);
      if (!r || !label) { tag.style.display = 'none'; return; }
      tag.textContent = label;
      Object.assign(tag.style, { display: 'block', left: `${r.left}px`, top: `${Math.max(0, r.top - 20)}px`, width: 'auto', height: 'auto' });
    },
    select(el) { place(select, el); },
    clearHover() { hover.style.display = 'none'; tag.style.display = 'none'; },
  };
}

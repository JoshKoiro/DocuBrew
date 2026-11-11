// The paginated preview. Each refresh renders into a hidden iframe and swaps it in when
// Paged.js finishes, so the visible preview never flickers or jumps.
import { pickElement, describe, findByKey, createOverlay } from './inspect.js';

const ZOOM_KEY = 'docubrew.zoom';
const STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

export function createPreview(canvas, { onRendered, onError, onBusy, onJump, onDropFiles, onDragHint, onZoom, onSelect, onInspectEnd }) {
  let current = null;   // visible iframe
  let pending = null;   // iframe being rendered
  let inspecting = false;
  let selectedKey = null;
  let selectedEl = null;
  let overlay = null;
  let liveRules = new Map(); // selector → decls, shown instantly until the re-render catches up
  let fit = readZoomMode() === 'fit';
  let zoom = fit ? 1 : readZoom();

  // In fit mode, re-fit whenever the preview area changes size (window, editor divider).
  new ResizeObserver(() => { if (fit) fitNow(); }).observe(canvas);

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('docubrew:')) return;
    if (!pending || e.source !== pending.contentWindow) return; // stale frame
    if (msg.type === 'docubrew:rendered') swapIn(msg);
    else if (msg.type === 'docubrew:error') fail(msg.message);
  });

  function refresh() {
    if (pending) pending.remove();
    pending = document.createElement('iframe');
    pending.className = 'frame is-pending';
    pending.title = 'Document preview';
    pending.src = `/preview/?t=${Date.now()}`;
    canvas.appendChild(pending);
    onBusy(true);
  }

  function swapIn(msg) {
    const next = pending;
    pending = null;
    const scroll = current ? scrollOf(current) : 0;
    applyTheme(next);
    applyZoom(next);
    attachInteractions(next);
    next.classList.remove('is-pending');
    if (fit) fitNow(next);
    if (current) current.remove();
    current = next;
    setScroll(current, scroll); // the hidden frame is already laid out, so this is exact
    liveRules.clear();
    reselect();
    onBusy(false);
    onRendered(msg);
  }

  function fail(message) {
    pending?.remove();
    pending = null;
    onBusy(false);
    onError(message);
  }

  function clear() {
    pending?.remove();
    current?.remove();
    pending = current = null;
  }

  function doc(frame) {
    try { return frame?.contentDocument; } catch { return null; }
  }
  function scrollOf(frame) {
    return doc(frame)?.scrollingElement?.scrollTop || 0;
  }
  function setScroll(frame, y) {
    const el = doc(frame)?.scrollingElement;
    if (el) el.scrollTop = y;
  }

  function applyZoom(frame = current) {
    const d = doc(frame);
    if (d?.body) d.body.style.zoom = String(zoom);
  }
  function applyTheme(frame = current) {
    const d = doc(frame);
    if (!d) return;
    const canvasColor = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
    d.documentElement.style.setProperty('--db-canvas', canvasColor);
  }

  // ── Interactions inside the rendered document ──────────────────────────────

  function attachInteractions(frame) {
    const d = doc(frame);
    if (!d) return;
    frame.overlay = createOverlay(d);
    d.documentElement.classList.toggle('db-inspecting', inspecting);

    // Inspect: hover outline + label, click selects.
    d.addEventListener('mousemove', (e) => {
      if (!inspecting || frame !== current) return;
      const el = pickElement(e.target);
      frame.overlay.hover(el, el ? describe(el).label : '');
    });
    d.addEventListener('mouseleave', () => frame.overlay.clearHover());
    d.addEventListener('click', (e) => {
      if (!inspecting) return;
      e.preventDefault();
      const el = pickElement(e.target);
      select(el);
    }, true);
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && inspecting) onInspectEnd?.();
    });
    d.addEventListener('scroll', () => {
      frame.overlay.clearHover();
      if (selectedEl) frame.overlay.select(selectedEl);
    }, { passive: true });

    const marker = d.createElement('div');
    marker.setAttribute('style', 'position:fixed;height:3px;background:#e2231a;pointer-events:none;z-index:9999;display:none;');
    d.documentElement.appendChild(marker); // outside <body>, so preview zoom doesn't affect it

    // Double-click anything to jump to its Markdown source.
    d.addEventListener('dblclick', (e) => {
      const hit = sourceAt(e.target, { outermost: false });
      if (hit) {
        e.preventDefault();
        d.getSelection()?.removeAllRanges();
        onJump?.({ file: hit.file, line: hit.line });
      }
    });

    const target = (e) => {
      const hit = sourceAt(e.target);
      if (!hit || !/\.md$/i.test(hit.file)) return null;
      if (!hit.el) return { file: hit.file, afterLine: hit.bodyLine - 1, rect: null };
      const rect = hit.el.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      return { file: hit.file, afterLine: before ? hit.line - 1 : hit.end, rect, before };
    };

    d.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const t = target(e);
      e.dataTransfer.dropEffect = t ? 'copy' : 'none';
      onDragHint?.(!t);
      if (t?.rect) {
        Object.assign(marker.style, {
          display: 'block',
          left: `${t.rect.left}px`,
          width: `${t.rect.width}px`,
          top: `${(t.before ? t.rect.top : t.rect.bottom) - 1}px`,
        });
      } else marker.style.display = 'none';
    });
    d.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) { marker.style.display = 'none'; onDragHint?.(false); }
    });
    d.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      marker.style.display = 'none';
      onDragHint?.(false);
      const t = target(e);
      if (t) onDropFiles?.([...e.dataTransfer.files], { file: t.file, afterLine: t.afterLine });
    });
  }

  function select(el) {
    selectedEl = el;
    selectedKey = null;
    const info = el ? describe(el) : null;
    if (info) selectedKey = info.key;
    current?.overlay?.select(el);
    onSelect?.(info);
  }

  // After a re-render, find the same element again and refresh the inspector's view of it.
  function reselect() {
    if (!selectedKey || !current) return;
    const el = findByKey(doc(current), selectedKey);
    selectedEl = el;
    current.overlay?.select(el);
    onSelect?.(el ? describe(el) : null, { refreshed: true });
  }

  function setInspecting(on) {
    inspecting = on;
    const d = doc(current);
    d?.documentElement.classList.toggle('db-inspecting', on);
    if (!on) current?.overlay?.clearHover();
  }

  /** Apply declarations instantly in the visible preview (pagination catches up on re-render). */
  function liveStyle(selector, decls) {
    liveRules.set(selector, { ...(liveRules.get(selector) || {}), ...decls });
    const d = doc(current);
    if (!d) return;
    let style = d.querySelector('style[data-docubrew="live"]');
    if (!style) {
      style = d.createElement('style');
      style.dataset.docubrew = 'live';
      d.head.appendChild(style);
    }
    style.textContent = [...liveRules]
      .map(([sel, dec]) => `${sel} { ${Object.entries(dec).filter(([, v]) => v).map(([k, v]) => `${k}: ${v} !important;`).join(' ')} }`)
      .join('\n');
    if (selectedEl) current.overlay?.select(selectedEl);
  }

  /** Scroll so the block containing `line` of `file` is at the top. */
  function scrollToSource(file, line) {
    const d = doc(current);
    if (!d) return;
    const sections = [...d.querySelectorAll(`[data-source-file="${CSS.escape(file)}"]`)];
    if (!sections.length) return;
    let best = null;
    let bestLine = -1;
    for (const sec of sections) {
      for (const el of sec.querySelectorAll('[data-source-line]')) {
        const l = Number(el.dataset.sourceLine);
        if (l <= line && l > bestLine) { best = el; bestLine = l; }
      }
    }
    const el = best || sections[0];
    const scroller = d.scrollingElement;
    const top = el.getBoundingClientRect().top + scroller.scrollTop - 28;
    scroller.scrollTop = Math.max(0, top);
  }

  function fitNow(frame = current) {
    const page = doc(frame)?.querySelector('.pagedjs_page');
    if (!page) return zoom;
    const pageWidth = page.getBoundingClientRect().width / (parseFloat(doc(frame).body.style.zoom) || 1);
    return setZoom((canvas.clientWidth - 48) / pageWidth, { frame, keepFit: true });
  }

  function setZoom(z, { frame = current, keepFit = false } = {}) {
    if (!keepFit) fit = false;
    const oldZoom = parseFloat(doc(frame)?.body?.style.zoom) || zoom;
    zoom = Math.min(3, Math.max(0.25, Math.round(z * 100) / 100));
    try { localStorage.setItem(ZOOM_KEY, fit ? 'fit' : String(zoom)); } catch {}
    onZoom?.(zoom, fit);
    if (frame !== current) { applyZoom(frame); return zoom; }
    // keep the same spot in view
    const y = scrollOf(current);
    applyZoom();
    setScroll(current, (y * zoom) / oldZoom);
    return zoom;
  }

  return {
    refresh,
    clear,
    get zoom() { return zoom; },
    zoomIn: () => setZoom(STEPS.find((s) => s > zoom + 0.001) ?? zoom),
    zoomOut: () => setZoom([...STEPS].reverse().find((s) => s < zoom - 0.001) ?? zoom),
    zoomReset: () => setZoom(1),
    get fit() { return fit; },
    zoomFit() {
      fit = true;
      return fitNow();
    },
    themeChanged: () => applyTheme(),
    scrollToSource,
    setInspecting,
    clearSelection: () => select(null),
    liveStyle,
    idExists: (id) => Boolean(doc(current)?.getElementById(id)),
    /** Content wider or taller than the page, from the rendered preview. */
    overflow() {
      try { return current?.contentWindow?.__docubrewOverflow?.() || []; } catch { return []; }
    },
    /** Instantly reflect an id/class change on the selected element (the re-render makes it permanent). */
    tagSelected({ id, addClasses = [], removeClasses = [] }) {
      if (!selectedEl) return;
      if (id) selectedEl.id = id;
      selectedEl.classList.remove(...removeClasses);
      selectedEl.classList.add(...addClasses);
      current?.overlay?.select(selectedEl);
    },
    get selected() { return selectedEl ? describe(selectedEl) : null; },
  };
}

function readZoomMode() {
  try { return localStorage.getItem(ZOOM_KEY) ?? 'fit'; } catch { return 'fit'; }
}

function readZoom() {
  try {
    const z = parseFloat(localStorage.getItem(ZOOM_KEY));
    return z > 0 ? z : 1;
  } catch {
    return 1;
  }
}

function hasFiles(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

/** The top-level Markdown block under a node, with its file and line range. */
function sourceAt(node, { outermost = true } = {}) {
  const elNode = node?.nodeType === 1 ? node : node?.parentElement;
  if (!elNode) return null;
  const section = elNode.closest('[data-source-file]');
  if (!section) return null;
  let el = elNode.closest('[data-source-line]');
  if (el && !section.contains(el)) el = null;
  // climb to the outermost block, so drops never land inside a list or callout
  while (el && outermost) {
    const parent = el.parentElement?.closest('[data-source-line]');
    if (!parent || !section.contains(parent)) break;
    el = parent;
  }
  const file = section.dataset.sourceFile;
  const bodyLine = Number(section.dataset.bodyLine || 1);
  if (!el) return { file, line: bodyLine, end: bodyLine - 1, bodyLine, el: null };
  return { file, line: Number(el.dataset.sourceLine), end: Number(el.dataset.sourceEnd || el.dataset.sourceLine), bodyLine, el };
}

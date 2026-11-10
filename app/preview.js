// The paginated preview. Each refresh renders into a hidden iframe and swaps it in when
// Paged.js finishes, so the visible preview never flickers or jumps.
const ZOOM_KEY = 'docubrew.zoom';
const STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

export function createPreview(canvas, { onRendered, onError, onBusy }) {
  let current = null;   // visible iframe
  let pending = null;   // iframe being rendered
  let zoom = readZoom();

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
    next.classList.remove('is-pending');
    if (current) current.remove();
    current = next;
    requestAnimationFrame(() => setScroll(current, scroll));
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

  function setZoom(z) {
    const oldZoom = zoom;
    zoom = Math.min(3, Math.max(0.25, Math.round(z * 100) / 100));
    try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch {}
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
    zoomFit() {
      const page = doc(current)?.querySelector('.pagedjs_page');
      if (!page) return zoom;
      const pageWidth = page.getBoundingClientRect().width / zoom;
      return setZoom((canvas.clientWidth - 64) / pageWidth);
    },
    themeChanged: () => applyTheme(),
  };
}

function readZoom() {
  try {
    const z = parseFloat(localStorage.getItem(ZOOM_KEY));
    return z > 0 ? z : 1;
  } catch {
    return 1;
  }
}

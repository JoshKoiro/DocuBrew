// Runs inside the rendered document (preview iframe and PDF export), before Paged.js loads.
// Reports when pagination is done, and adds screen-only page presentation in preview mode.
(function () {
  const started = performance.now();
  const mode = document.documentElement.dataset.mode || 'preview';
  window.__docubrew = { done: false, pages: 0, ms: 0, error: null, mode };

  function notify(msg) {
    if (window.parent !== window) window.parent.postMessage(msg, '*');
  }

  window.addEventListener('error', (e) => {
    if (!window.__docubrew.done) notify({ type: 'docubrew:warning', message: e.message });
  });

  window.PagedConfig = {
    auto: true,
    after() {
      const pages = document.querySelectorAll('.pagedjs_page').length;
      Object.assign(window.__docubrew, { done: true, pages, ms: Math.round(performance.now() - started) });
      if (mode === 'preview') addScreenChrome();
      notify({ type: 'docubrew:rendered', pages, ms: window.__docubrew.ms });
    },
  };

  // Used by `docubrew check --render` and the app's Check: content that doesn't fit the page box.
  window.__docubrewOverflow = function () {
    const out = [];
    const seen = new Set();
    const names = { IMG: 'Image', FIGURE: 'Figure', TABLE: 'Table', PRE: 'Code block', SVG: 'Graphic' };
    document.querySelectorAll('.pagedjs_page').forEach((page, i) => {
      const area = page.querySelector('.pagedjs_page_content');
      if (!area) return;
      const box = area.getBoundingClientRect();
      const zoom = parseFloat(document.body.style.zoom) || 1;
      area.querySelectorAll('img, figure, table, pre, svg, [data-source-line]').forEach((el) => {
        const r = el.getBoundingClientRect();
        const wide = r.right - box.right;
        const tall = (el.tagName === 'IMG' || el.tagName === 'FIGURE') && r.height > box.height + 2;
        const scrolls = el.tagName === 'PRE' && el.scrollWidth > el.clientWidth + 2;
        if (wide <= 2 && !tall && !scrolls) return;
        const src = el.closest('[data-source-line]');
        const section = el.closest('[data-source-file]');
        const key = `${section?.dataset.sourceFile}:${src?.dataset.sourceLine}:${el.tagName}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          page: i + 1,
          file: section?.dataset.sourceFile || null,
          line: src?.dataset.sourceLine || null,
          what: names[el.tagName] || 'Content',
          kind: tall ? 'tall' : 'wide',
          by: Math.round((scrolls ? el.scrollWidth - el.clientWidth : wide) / zoom),
        });
      });
    });
    return out;
  };

  // Added after Paged.js has processed the stylesheets, so it never reaches print.
  function addScreenChrome() {
    const style = document.createElement('style');
    style.dataset.docubrew = 'screen';
    style.textContent = `
      html, body { background: var(--db-canvas, #e4e3de); margin: 0; }
      .pagedjs_pages { display: flex; flex-direction: column; align-items: safe center; gap: 24px; padding: 32px 0 64px; }
      .pagedjs_page { background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.08); margin: 0 !important; }
      .db-inspecting, .db-inspecting * { cursor: crosshair !important; }
    `;
    document.head.appendChild(style);
  }
})();

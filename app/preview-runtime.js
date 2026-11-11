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

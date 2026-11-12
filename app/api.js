// Thin client for the DocuBrew server.
//
// Each tab is its own session (its own open Brew and preview); each browser has a client id,
// and edit locks belong to the browser, so two tabs here never lock each other out.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const rand = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^\w-]/g, '');
export const session = {
  id: rand(), // per page load, never copied when a tab is duplicated
  client: store.get('docubrew.client') || (() => { const c = rand(); store.set('docubrew.client', c); return c; })(),
  get user() { return store.get('docubrew.user') || ''; },
  set user(v) { store.set('docubrew.user', v); },
};
export const previewBase = () => `/s/${session.id}/preview/`;
const headers = (extra = {}) => ({
  'x-docubrew-session': session.id,
  'x-docubrew-client': session.client,
  'x-docubrew-user': encodeURIComponent(session.user),
  ...extra,
});

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: headers(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${method} ${url} failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function upload(file) {
  const res = await fetch(`/api/images?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

export const api = {
  state: (brew, { peek } = {}) => request('GET', `/api/state?${peek ? 'peek=1' : brew ? `brew=${encodeURIComponent(brew)}` : ''}`),
  close: () => request('POST', '/api/close'),
  takeOver: () => request('POST', '/api/lock/take-over'),
  deleteBrew: (path) => request('POST', '/api/brews/delete', { path }),
  trash: () => request('GET', '/api/trash'),
  restoreTrash: (id) => request('POST', '/api/trash/restore', { id }),
  purgeTrash: (id) => request('POST', '/api/trash/purge', { id }),
  brews: () => request('GET', '/api/brews'),
  blends: () => request('GET', '/api/blends'),
  browse: (path) => request('GET', `/api/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  open: (path) => request('POST', '/api/open', { path }),
  create: (data) => request('POST', '/api/brews', data),
  exportPdf: () => request('POST', '/api/export'),
  reveal: (app, path, select) => request('POST', '/api/reveal', { app, path, select }),
  files: () => request('GET', '/api/files'),
  file: (path) => request('GET', `/api/file?path=${encodeURIComponent(path)}`),
  saveFile: (path, content, baseMtime) => request('PUT', '/api/file', { path, content, baseMtime }),
  newChapter: (title) => request('POST', '/api/chapters', { title }),
  uploadImage: upload,
  presets: () => request('GET', '/api/presets'),
  getStyle: (selector, file) => request('GET', `/api/style?selector=${encodeURIComponent(selector)}${file ? `&file=${encodeURIComponent(file)}` : ''}`),
  setStyle: (selector, set, file) => request('POST', '/api/style', { selector, set, file }),
  samples: () => request('POST', '/api/samples'),
  pack: () => request('POST', '/api/pack'),
  importPath: (path) => request('POST', '/api/import-path', { path }),
  importFile: async (file) => {
    const res = await fetch(`/api/import?name=${encodeURIComponent(file.name.replace(/\.brew$/i, ''))}`, { method: 'POST', body: file, headers: headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);
    return data;
  },
  adoptBlend: () => request('POST', '/api/blend/adopt'),
  check: () => request('GET', '/api/check'),
  context: (content = true) => request('GET', `/api/context?content=${content ? 1 : 0}`),
  allBlends: () => request('GET', '/api/blends?all=1'),
  blendStatus: () => request('GET', '/api/blend/status'),
  blendDiff: () => request('GET', '/api/blend/diff'),
  blendUpdate: () => request('POST', '/api/blend/update'),
  openBlend: (id, previewWith) => request('POST', '/api/blend/open', { id, previewWith }),
  previewWith: (path) => request('POST', '/api/blend/preview-with', { path }),
  createBlend: (data) => request('POST', '/api/blend/create', data),
  releaseBlend: (data) => request('POST', '/api/blend/release', data),
  setAttrs: (body) => request('POST', '/api/attrs', body),
};

/** Live connection: calls onMessage for server events, reconnects with backoff. */
export function connectLive({ onMessage, onStatus }) {
  let delay = 500;
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?session=${session.id}&client=${session.client}`);
    ws.onopen = () => { delay = 500; onStatus(true); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => {
      onStatus(false);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };
  }
  connect();
}

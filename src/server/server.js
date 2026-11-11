// The local DocuBrew server: serves the app, renders what's open, watches its files,
// and pushes "changed" events to the browser over a WebSocket.
//
// Two modes:
//   brew   a document project. Edits go to its files; its blend/ copy is read-only.
//   blend  a Library Blend in the Blend Editor. It's flattened (with everything it extends) into a temp
//          folder on every change and previewed against the bundled specimen or any Brew's content.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { watch } from 'chokidar';
import { APP_ROOT, ensureWorkspace, listBrews, listLibrary, createBrew, libraryDir, attachBlend, restoreSamples, createBlend, releaseBlend, describeBlend, adoptBrewBlend } from '../core/workspace.js';
import { packBrew, unpackBrew, BREW_EXT } from '../core/brewfile.js';
import { isBrew, describeBrew, DIST_DIR, BLEND_DIR } from '../core/brew.js';
import { renderBrew, wrapLayer } from '../core/render.js';
import { flattenBlend, resolveChain } from '../core/blend.js';
import { blendStatus, blendDiff } from '../core/blend-status.js';
import { exportPdf } from '../core/pdf.js';
import { slugify, escapeHtml } from '../core/util.js';
import { safeJoin, sendFile } from './static.js';
import { getPresets, getStyle, setStyle, getAttrs, setAttrs } from './styling.js';
import { listBrewFiles, listBlendFiles, readBrewFile, writeBrewFile, createChapter, saveImage, readBody, HttpError, MAX_IMAGE_BYTES } from './files.js';

const NM = path.join(APP_ROOT, 'node_modules');
const VENDOR = {
  '/vendor/paged.polyfill.js': path.join(NM, 'pagedjs', 'dist', 'paged.polyfill.js'),
};
const VENDOR_DIRS = {
  '/vendor/fonts/inter/': path.join(NM, '@fontsource', 'inter'),
  '/vendor/fonts/inter-tight/': path.join(NM, '@fontsource', 'inter-tight'),
};
export const SPECIMEN_DIR = path.join(APP_ROOT, 'specimen');
const MAX_BREW_BYTES = 512 * 1024 * 1024;

export async function startServer({ workspace, port = 4747, host = '127.0.0.1', brew = null, quiet = false } = {}) {
  await ensureWorkspace(workspace);
  const library = libraryDir(workspace);
  const statePath = path.join(workspace, '.docubrew', 'state.json');
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docubrew-'));
  const state = {
    mode: 'brew',
    brewDir: null,      // brew mode: the open Brew
    blendId: null,      // blend mode: the Library Blend being edited
    previewWith: null,  // blend mode: folder whose content previews the Blend (specimen or a Brew)
    flatDir: null,      // blend mode: current flattened copy
    varsOverride: null, // CLI batch builds: variables merged over brew.yaml's
    watcher: null,
  };
  const sockets = new Set();
  const log = (...a) => { if (!quiet) console.log(...a); };

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === 1) ws.send(data);
  };

  async function remember(patch) {
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch {}
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ ...saved, ...patch }, null, 2)).catch(() => {});
  }

  async function openBrew(dir) {
    dir = path.resolve(dir);
    if (!(await isBrew(dir))) throw new Error(`Not a Brew (no brew.yaml): ${dir}`);
    await state.watcher?.close();
    Object.assign(state, { mode: 'brew', brewDir: dir, blendId: null, previewWith: null });
    state.watcher = watchDirs([dir], dir, (files) => broadcast({ type: 'changed', files }));
    await remember({ lastBrew: dir });
    const info = await describeBrew(dir);
    broadcast({ type: 'opened', mode: 'brew', brew: info });
    log(`Opened ${dir}`);
    return info;
  }

  async function flattenForPreview() {
    const next = path.join(tmpRoot, `${state.blendId}-${Date.now()}`);
    await flattenBlend(library, state.blendId, next);
    const old = state.flatDir;
    state.flatDir = next;
    if (old) setTimeout(() => fs.rm(old, { recursive: true, force: true }).catch(() => {}), 5000);
  }

  async function openBlend(id, { previewWith } = {}) {
    const chain = await resolveChain(library, id); // throws if missing
    let content = previewWith || state.previewWith || SPECIMEN_DIR;
    if (content !== SPECIMEN_DIR && !(await isBrew(content))) content = SPECIMEN_DIR;
    await state.watcher?.close();
    Object.assign(state, { mode: 'blend', blendId: id, previewWith: content });
    await flattenForPreview();
    const blendDir = path.join(library, id);
    state.watcher = watchDirs([...chain.map((c) => c.dir), content], blendDir, async (files) => {
      try { await flattenForPreview(); } catch (err) { log(err.message); }
      broadcast({ type: 'changed', files });
    });
    await remember({ lastBlendPreview: content });
    const info = await blendInfo();
    broadcast({ type: 'opened', mode: 'blend', blend: info });
    log(`Blend Editor: ${id}`);
    return info;
  }

  async function blendInfo() {
    const b = await describeBlend(workspace, state.blendId);
    return { ...b, path: b.dir, title: b.name, previewWith: state.previewWith === SPECIMEN_DIR ? 'specimen' : state.previewWith };
  }

  // Where the editor reads and writes files.
  function editRoot() {
    if (state.mode === 'blend') return path.join(library, state.blendId);
    if (!state.brewDir) throw new HttpError(409, 'No Brew is open.');
    return state.brewDir;
  }
  const blendMode = () => state.mode === 'blend';
  function requireBrew() {
    if (state.mode !== 'brew' || !state.brewDir) throw new HttpError(409, 'Open a Brew for this.');
    return state.brewDir;
  }

  // Reopen the explicitly requested Brew, or the last one used.
  try {
    if (brew) await openBrew(brew);
    else {
      const last = JSON.parse(await fs.readFile(statePath, 'utf8')).lastBrew;
      if (last && (await isBrew(last))) await openBrew(last);
    }
  } catch (err) {
    if (brew) throw err;
  }

  const api = {
    'GET /api/state': async () => ({
      workspace,
      mode: state.mode,
      brew: state.mode === 'brew' && state.brewDir ? await describeBrew(state.brewDir) : null,
      blend: state.mode === 'blend' ? await blendInfo() : null,
    }),
    'GET /api/brews': async () => listBrews(workspace),
    'GET /api/blends': async (_b, url) => (await listLibrary(workspace)).filter((b) => url.searchParams.get('all') || !b.abstract),
    'POST /api/open': async (body) => openBrew(body.path),
    'POST /api/brews': async (body) => {
      const info = await createBrew(workspace, body);
      return openBrew(info.path);
    },
    'POST /api/samples': async () => restoreSamples(workspace),

    // .brew files
    'POST /api/pack': async () => {
      const r = await packBrew(requireBrew());
      log(`Packed ${r.file}`);
      return { ...r, url: `/preview/${DIST_DIR}/${encodeURIComponent(path.basename(r.file))}` };
    },
    'POST /api/import': async (_b, url, req) => importBrew(await readBody(req, MAX_BREW_BYTES), url.searchParams.get('name')),
    'POST /api/import-path': async (body) => {
      if (!String(body.path || '').toLowerCase().endsWith(BREW_EXT)) throw new HttpError(400, 'Choose a .brew file.');
      return importBrew(await fs.readFile(body.path), null);
    },
    'POST /api/blend/adopt': async () => {
      const b = await adoptBrewBlend(workspace, requireBrew());
      return { blend: b, status: await blendStatus(library, state.brewDir) };
    },
    'GET /api/fs': async (_b, url) => browse(url.searchParams.get('path') || workspace),
    'POST /api/export': async () => {
      const dir = requireBrew();
      const info = await describeBrew(dir);
      const name = `${slugify(info.title)}.pdf`;
      const out = path.join(dir, DIST_DIR, name);
      const result = await exportPdf(`${server.url}/preview/?mode=print`, out);
      log(`Exported ${out} (${result.pages} pages, ${result.ms} ms)`);
      return { ...result, url: `/preview/${DIST_DIR}/${encodeURIComponent(name)}` };
    },

    // Editor files (Brew or Blend, depending on mode)
    'GET /api/files': async () => (blendMode() ? listBlendFiles(editRoot()) : listBrewFiles(editRoot())),
    'GET /api/file': async (_b, url) => readBrewFile(editRoot(), url.searchParams.get('path'), { blendMode: blendMode() }),
    'PUT /api/file': async (body) => writeBrewFile(editRoot(), body.path, body.content, body.baseMtime, { blendMode: blendMode() }),
    'POST /api/chapters': async (body) => createChapter(requireBrew(), body.title),
    'POST /api/images': async (_b, url, req) => saveImage(requireBrew(), url.searchParams.get('name') || '', await readBody(req, MAX_IMAGE_BYTES)),

    // Inspector
    'GET /api/presets': async () => getPresets(blendMode() ? state.flatDir : path.join(requireBrew(), BLEND_DIR)),
    'GET /api/style': async (_b, url) => getStyle(editRoot(), url.searchParams.get('selector') || '', url.searchParams.get('file') || undefined),
    'POST /api/style': async (body) => setStyle(editRoot(), body.selector, body.set, body.file || undefined),
    'GET /api/attrs': async (_b, url) => getAttrs(requireBrew(), Object.fromEntries(url.searchParams)),
    'POST /api/attrs': async (body) => setAttrs(requireBrew(), body),

    // Blend copy in a Brew vs. the Library
    'GET /api/blend/status': async () => blendStatus(library, requireBrew()),
    'GET /api/blend/diff': async () => blendDiff(library, requireBrew()),
    'POST /api/blend/update': async () => {
      const dir = requireBrew();
      const status = await blendStatus(library, dir);
      if (!status.source || status.state === 'missing') throw new HttpError(404, `Blend "${status.source}" isn't in the Library.`);
      await attachBlend(workspace, dir, status.source);
      return blendStatus(library, dir);
    },

    // Blend Editor
    'POST /api/blend/open': async (body) => openBlend(body.id, { previewWith: body.previewWith === 'specimen' ? SPECIMEN_DIR : body.previewWith }),
    'POST /api/blend/preview-with': async (body) => openBlend(state.blendId, { previewWith: body.path === 'specimen' ? SPECIMEN_DIR : body.path }),
    'POST /api/blend/create': async (body) => {
      const { id } = await createBlend(workspace, body);
      return openBlend(id);
    },
    'POST /api/blend/release': async (body) => {
      if (!blendMode()) throw new HttpError(409, 'Open a Blend in the Blend Editor first.');
      const r = await releaseBlend(workspace, state.blendId, body);
      return { ...r, blend: await blendInfo() };
    },

    'POST /api/reveal': async (body) => {
      const target = body.path || (blendMode() ? editRoot() : state.brewDir);
      if (!target) throw new Error('Nothing to reveal.');
      reveal(target, body.app, Boolean(body.select));
      return { ok: true };
    },
  };

  async function importBrew(buffer, name) {
    const info = await unpackBrew(buffer, workspace, { name: name || undefined });
    log(`Imported ${info.path}`);
    await openBrew(info.path);
    return info;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    const route = api[`${req.method} ${p}`];
    if (route) {
      try {
        const raw = p === '/api/images' || p === '/api/import';
        const body = !raw && (req.method === 'POST' || req.method === 'PUT') ? await readJson(req) : {};
        return json(res, 200, await route(body, url, req));
      } catch (err) {
        return json(res, err instanceof HttpError ? err.status : 400, { error: err.message, ...(err.data || {}) });
      }
    }

    if (req.method !== 'GET') return notFound(res);

    if (p === '/' || p === '/index.html') return void (await sendFile(res, path.join(APP_ROOT, 'app', 'index.html')));
    if (p.startsWith('/app/')) {
      const f = safeJoin(path.join(APP_ROOT, 'app'), p.slice(5));
      if (f && (await sendFile(res, f))) return;
      return notFound(res);
    }
    if (VENDOR[p]) return void ((await sendFile(res, VENDOR[p])) || notFound(res));
    for (const [prefix, dir] of Object.entries(VENDOR_DIRS)) {
      if (p.startsWith(prefix)) {
        const f = safeJoin(dir, p.slice(prefix.length));
        if (f && (await sendFile(res, f))) return;
        return notFound(res);
      }
    }

    if (p === '/preview/' || p === '/preview/index.html') return renderPreview(res, url);
    if (p.startsWith('/preview/')) {
      const rel = p.slice('/preview/'.length);
      let f = null;
      if (blendMode()) {
        // blend/… comes from the live flattened Blend; everything else from the preview content
        f = rel.startsWith(`${BLEND_DIR}/`) ? safeJoin(state.flatDir, rel.slice(BLEND_DIR.length + 1)) : safeJoin(state.previewWith, rel);
      } else if (state.brewDir) {
        f = safeJoin(state.brewDir, rel);
      }
      const layer = url.searchParams.get('layer');
      const ok = f && (await sendFile(res, f, layer && f.endsWith('.css') ? { transform: (css) => wrapLayer(css, layer) } : {}));
      return ok || notFound(res);
    }
    if (p === '/favicon.ico') return void ((await sendFile(res, path.join(APP_ROOT, 'app', 'favicon.svg'))) || notFound(res));
    notFound(res);
  }

  async function renderPreview(res, url) {
    const mode = url.searchParams.get('mode') === 'print' ? 'print' : 'preview';
    try {
      if (blendMode()) {
        const { html: doc } = await renderBrew(state.previewWith, { mode, blendDir: state.flatDir });
        return html(res, 200, doc);
      }
      if (!state.brewDir) return html(res, 200, errorPage('No Brew is open.'));
      const { html: doc } = await renderBrew(state.brewDir, { mode, vars: state.varsOverride });
      html(res, 200, doc);
    } catch (err) {
      html(res, 200, errorPage(err.message));
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: err.message });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
    });
  });

  const actualPort = await listen(server, port, host);
  server.url = `http://${host}:${actualPort}`;
  server.openBrew = openBrew;
  server.openBlend = openBlend;
  server.state = state;
  const close = server.close.bind(server);
  server.close = async () => {
    await state.watcher?.close();
    for (const ws of sockets) ws.terminate();
    await new Promise((r) => close(r));
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  };
  return server;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Watch folders; report changed paths relative to `root` (paths outside it are prefixed "../"). */
function watchDirs(dirs, root, onChange) {
  let pending = new Set();
  let timer = null;
  const skip = new Set([DIST_DIR, '.git', 'node_modules', '.docubrew']);
  const ignored = (p) => dirs.some((d) => path.relative(d, p).split(path.sep).some((seg) => skip.has(seg)));
  const watcher = watch([...new Set(dirs)], {
    ignoreInitial: true,
    ignored,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  });
  watcher.on('all', (_event, file) => {
    pending.add(path.relative(root, file).split(path.sep).join('/'));
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending];
      pending = new Set();
      onChange(files);
    }, 80);
  });
  return watcher;
}

async function browse(target) {
  const dir = path.resolve(target);
  const entries = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) entries.push({ name: e.name, path: full, type: 'dir', isBrew: await isBrew(full) });
    else if (e.isFile() && e.name.toLowerCase().endsWith('.brew')) entries.push({ name: e.name, path: full, type: 'brewfile' });
  }
  entries.sort((a, b) => (b.isBrew - a.isBrew) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, isBrew: await isBrew(dir), entries };
}

/** Open a folder in the OS file manager (or VS Code). With `select`, highlight a file in its folder. */
function reveal(target, app, select = false) {
  const quoted = `"${String(target).replace(/"/g, '')}"`;
  let cmd;
  if (app === 'code') cmd = `code ${quoted}`;
  else if (process.platform === 'win32') cmd = select ? `explorer /select,${quoted}` : `explorer ${quoted}`;
  else if (process.platform === 'darwin') cmd = select ? `open -R ${quoted}` : `open ${quoted}`;
  else cmd = `xdg-open "${select ? path.dirname(target) : target}"`;
  spawn(cmd, { shell: true, detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

function listen(server, port, host, tries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (p, left) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && left > 0 && port !== 0) attempt(p + 1, left - 1);
        else reject(err);
      });
      server.listen(p, host, () => resolve(server.address().port));
    };
    attempt(port, tries);
  });
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}

function errorPage(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Render error</title>
<script>window.__docubrew={error:${JSON.stringify(message)}};parent.postMessage({type:'docubrew:error',message:${JSON.stringify(message)}},'*');</script>
<style>body{font:14px/1.5 system-ui,sans-serif;padding:3rem;color:#111;background:#f8f7f4}pre{white-space:pre-wrap;color:#e2231a}</style>
</head><body><p>DocuBrew couldn't render this Brew.</p><pre>${escapeHtml(message)}</pre></body></html>`;
}

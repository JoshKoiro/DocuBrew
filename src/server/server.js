// The local DocuBrew server: serves the app, renders the open Brew, watches its files,
// and pushes "changed" events to the browser over a WebSocket.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { watch } from 'chokidar';
import { APP_ROOT, ensureWorkspace, listBrews, listLibrary, createBrew } from '../core/workspace.js';
import { isBrew, describeBrew, DIST_DIR } from '../core/brew.js';
import { renderBrew, wrapLayer } from '../core/render.js';
import { exportPdf } from '../core/pdf.js';
import { slugify, escapeHtml } from '../core/util.js';
import { safeJoin, sendFile } from './static.js';
import { getPresets, getStyle, setStyle, getAttrs, setAttrs } from './styling.js';
import { listBrewFiles, readBrewFile, writeBrewFile, createChapter, saveImage, readBody, HttpError, MAX_IMAGE_BYTES } from './files.js';

const NM = path.join(APP_ROOT, 'node_modules');
const VENDOR = {
  '/vendor/paged.polyfill.js': path.join(NM, 'pagedjs', 'dist', 'paged.polyfill.js'),
};
const VENDOR_DIRS = {
  '/vendor/fonts/inter/': path.join(NM, '@fontsource', 'inter'),
  '/vendor/fonts/inter-tight/': path.join(NM, '@fontsource', 'inter-tight'),
};

export async function startServer({ workspace, port = 4747, host = '127.0.0.1', brew = null, quiet = false } = {}) {
  await ensureWorkspace(workspace);
  const statePath = path.join(workspace, '.docubrew', 'state.json');
  const state = { brewDir: null, watcher: null };
  const sockets = new Set();
  const log = (...a) => { if (!quiet) console.log(...a); };

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === 1) ws.send(data);
  };

  async function openBrew(dir) {
    dir = path.resolve(dir);
    if (!(await isBrew(dir))) throw new Error(`Not a Brew (no brew.yaml): ${dir}`);
    await state.watcher?.close();
    state.brewDir = dir;
    state.watcher = watchBrew(dir, (files) => broadcast({ type: 'changed', files }));
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ lastBrew: dir }, null, 2)).catch(() => {});
    const info = await describeBrew(dir);
    broadcast({ type: 'opened', brew: info });
    log(`Opened ${dir}`);
    return info;
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
      brew: state.brewDir ? await describeBrew(state.brewDir) : null,
    }),
    'GET /api/brews': async () => listBrews(workspace),
    'GET /api/blends': async () => (await listLibrary(workspace)).filter((b) => !b.abstract),
    'POST /api/open': async (body) => openBrew(body.path),
    'POST /api/brews': async (body) => {
      const info = await createBrew(workspace, body);
      return openBrew(info.path);
    },
    'GET /api/fs': async (_b, url) => browse(url.searchParams.get('path') || workspace),
    'POST /api/export': async () => {
      if (!state.brewDir) throw new Error('No Brew is open.');
      const info = await describeBrew(state.brewDir);
      const name = `${slugify(info.title)}.pdf`;
      const out = path.join(state.brewDir, DIST_DIR, name);
      const result = await exportPdf(`${server.url}/preview/?mode=print`, out);
      log(`Exported ${out} (${result.pages} pages, ${result.ms} ms)`);
      return { ...result, url: `/preview/${DIST_DIR}/${encodeURIComponent(name)}` };
    },
    'GET /api/files': async () => listBrewFiles(requireBrew()),
    'GET /api/file': async (_b, url) => readBrewFile(requireBrew(), url.searchParams.get('path')),
    'PUT /api/file': async (body) => writeBrewFile(requireBrew(), body.path, body.content, body.baseMtime),
    'POST /api/chapters': async (body) => createChapter(requireBrew(), body.title),
    'POST /api/images': async (_b, url, req) => saveImage(requireBrew(), url.searchParams.get('name') || '', await readBody(req, MAX_IMAGE_BYTES)),
    'GET /api/presets': async () => getPresets(requireBrew()),
    'GET /api/style': async (_b, url) => getStyle(requireBrew(), url.searchParams.get('selector') || ''),
    'POST /api/style': async (body) => setStyle(requireBrew(), body.selector, body.set),
    'GET /api/attrs': async (_b, url) => getAttrs(requireBrew(), Object.fromEntries(url.searchParams)),
    'POST /api/attrs': async (body) => setAttrs(requireBrew(), body),
    'POST /api/reveal': async (body) => {
      const target = body.path || state.brewDir;
      if (!target) throw new Error('Nothing to reveal.');
      reveal(target, body.app, Boolean(body.select));
      return { ok: true };
    },
  };

  function requireBrew() {
    if (!state.brewDir) throw new HttpError(409, 'No Brew is open.');
    return state.brewDir;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    const route = api[`${req.method} ${p}`];
    if (route) {
      try {
        const raw = p === '/api/images';
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
      if (!state.brewDir) return notFound(res);
      const f = safeJoin(state.brewDir, p.slice('/preview/'.length));
      const layer = url.searchParams.get('layer');
      const ok = f && (await sendFile(res, f, layer && f.endsWith('.css') ? { transform: (css) => wrapLayer(css, layer) } : {}));
      return ok || notFound(res);
    }
    if (p === '/favicon.ico') return void ((await sendFile(res, path.join(APP_ROOT, 'app', 'favicon.svg'))) || notFound(res));
    notFound(res);
  }

  async function renderPreview(res, url) {
    const mode = url.searchParams.get('mode') === 'print' ? 'print' : 'preview';
    if (!state.brewDir) return html(res, 200, errorPage('No Brew is open.'));
    try {
      const { html: doc } = await renderBrew(state.brewDir, { mode });
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
  server.state = state;
  const close = server.close.bind(server);
  server.close = async () => {
    await state.watcher?.close();
    for (const ws of sockets) ws.terminate();
    await new Promise((r) => close(r));
  };
  return server;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function watchBrew(dir, onChange) {
  let pending = new Set();
  let timer = null;
  const skip = new Set([DIST_DIR, '.git', 'node_modules', '.docubrew']);
  const ignored = (p) => path.relative(dir, p).split(path.sep).some((seg) => skip.has(seg));
  const watcher = watch(dir, {
    ignoreInitial: true,
    ignored,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  });
  watcher.on('all', (_event, file) => {
    pending.add(path.relative(dir, file).split(path.sep).join('/'));
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

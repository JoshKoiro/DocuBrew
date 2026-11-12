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
import { checkBrew } from '../core/check.js';
import { buildContext } from '../core/context.js';
import { isBrew, describeBrew, DIST_DIR, BLEND_DIR } from '../core/brew.js';
import { renderBrew, wrapLayer } from '../core/render.js';
import { flattenBlend, resolveChain } from '../core/blend.js';
import { blendStatus, blendDiff } from '../core/blend-status.js';
import { exportPdf } from '../core/pdf.js';
import { slugify, escapeHtml } from '../core/util.js';
import { trashBrew, listTrash, restoreTrash, purgeTrash, insideWorkspace } from '../core/trash.js';
import { randomBytes } from 'node:crypto';
import { Locks } from './locks.js';
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

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const SESSION_IDLE_MS = 2 * 60 * 1000; // a tab that's gone this long releases its lock

/**
 * @param {object} o
 *   workspace  workspace folder
 *   port, host host 127.0.0.1 = local only; anything else is server mode (GitHub #6)
 *   token      access token for server mode (generated and saved if not given); false = no auth
 *   brew       Brew to open in the first session
 */
export async function startServer({ workspace, port = 4747, host = '127.0.0.1', token, brew = null, quiet = false } = {}) {
  await ensureWorkspace(workspace);
  const library = libraryDir(workspace);
  const statePath = path.join(workspace, '.docubrew', 'state.json');
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docubrew-'));
  const serverMode = !LOOPBACK.has(host);
  const log = (...a) => { if (!quiet) console.log(...a); };
  const locks = new Locks();
  const sessions = new Map(); // id → session
  // Locally everyone is the same person, so a lock held elsewhere is "another browser".
  const localUser = 'Another browser';

  // Server mode is protected by a token (in the URL once, then a cookie).
  if (serverMode && token === undefined) token = await savedToken(workspace);
  const authRequired = serverMode && token !== false;

  async function remember(patch) {
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch {}
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ ...saved, ...patch }, null, 2)).catch(() => {});
  }
  async function lastBrew() {
    try {
      const last = JSON.parse(await fs.readFile(statePath, 'utf8')).lastBrew;
      return last && (await isBrew(last)) ? last : null;
    } catch { return null; }
  }

  // ── Sessions: one per browser tab ─────────────────────────────────────────
  function getSession(id, { clientId, user } = {}) {
    const sid = /^[\w-]{3,64}$/.test(id || '') ? id : 'default';
    let s = sessions.get(sid);
    if (!s) {
      s = {
        id: sid,
        clientId: clientId || 'local',
        user: user || (serverMode ? 'Someone' : localUser),
        mode: 'brew',
        brewDir: null,      // brew mode: the open Brew
        blendId: null,      // blend mode: the Library Blend being edited
        previewWith: null,  // blend mode: folder whose content previews the Blend
        flatDir: null,      // blend mode: current flattened copy
        varsOverride: null, // CLI batch builds
        watcher: null,
        sockets: new Set(),
        lastSeen: Date.now(),
      };
      sessions.set(sid, s);
    }
    if (clientId) s.clientId = clientId;
    if (user) s.user = user;
    s.lastSeen = Date.now();
    return s;
  }

  const send = (session, msg) => {
    const data = JSON.stringify(msg);
    for (const ws of session.sockets) if (ws.readyState === 1) ws.send(data);
  };
  const lockTarget = (s) => (s.mode === 'blend' ? path.join(library, s.blendId) : s.brewDir);

  const viewing = (target) => [...sessions.values()].filter((o) => (o.blendId || o.brewDir) && lockTarget(o) === target);

  /** Tell every other session looking at `target` whether it can edit now. */
  function announceLock(target, except) {
    for (const o of viewing(target)) {
      if (o === except) continue;
      send(o, { type: 'lock', lock: locks.acquire(target, o) }); // the first one waiting gets it
    }
  }

  async function release(s) {
    const target = s.blendId || s.brewDir ? lockTarget(s) : null;
    s.brewDir = null; s.blendId = null; // so it no longer counts as viewing
    if (target) {
      locks.release(target, s);
      announceLock(target, s);
    }
    await s.watcher?.close();
    s.watcher = null;
  }

  async function closeSession(s) {
    await release(s);
    for (const ws of s.sockets) ws.terminate();
    sessions.delete(s.id);
  }

  // Tabs that have gone away release their locks.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.id === 'default' || s.id === 'cli') continue;
      if (!s.sockets.size && now - s.lastSeen > SESSION_IDLE_MS) closeSession(s).catch(() => {});
    }
  }, 30_000);
  sweeper.unref?.();

  async function openBrew(s, dir) {
    dir = path.resolve(dir);
    if (!(await isBrew(dir))) throw new Error(`Not a Brew (no brew.yaml): ${dir}`);
    if (serverMode && !insideWorkspace(workspace, dir)) throw new HttpError(403, 'Only Brews in the workspace can be opened in server mode.');
    if (s.mode === 'brew' && s.brewDir === dir && s.watcher) return { ...(await describeBrew(dir)), lock: locks.acquire(dir, s) }; // already open here
    await release(s);
    Object.assign(s, { mode: 'brew', brewDir: dir, blendId: null, previewWith: null });
    const lock = locks.acquire(dir, s);
    s.watcher = watchDirs([dir], dir, (files) => send(s, { type: 'changed', files }));
    await remember({ lastBrew: dir });
    const info = { ...(await describeBrew(dir)), lock };
    send(s, { type: 'opened', mode: 'brew', brew: info });
    log(`Opened ${dir}${lock.editable ? '' : ` (read-only: ${lock.holder} is editing)`}`);
    return info;
  }

  async function flattenForPreview(s) {
    const next = path.join(tmpRoot, `${s.id}-${s.blendId}-${Date.now()}`);
    await flattenBlend(library, s.blendId, next);
    const old = s.flatDir;
    s.flatDir = next;
    if (old) setTimeout(() => fs.rm(old, { recursive: true, force: true }).catch(() => {}), 5000);
  }

  async function openBlend(s, id, { previewWith } = {}) {
    const chain = await resolveChain(library, id); // throws if missing
    let content = previewWith || s.previewWith || SPECIMEN_DIR;
    if (content !== SPECIMEN_DIR && (!(await isBrew(content)) || (serverMode && !insideWorkspace(workspace, content)))) content = SPECIMEN_DIR;
    await release(s);
    Object.assign(s, { mode: 'blend', blendId: id, brewDir: null, previewWith: content });
    const lock = locks.acquire(path.join(library, id), s);
    await flattenForPreview(s);
    s.watcher = watchDirs([...chain.map((c) => c.dir), content], path.join(library, id), async (files) => {
      try { await flattenForPreview(s); } catch (err) { log(err.message); }
      send(s, { type: 'changed', files });
    });
    const info = await blendInfo(s);
    send(s, { type: 'opened', mode: 'blend', blend: info });
    log(`Blend Editor: ${id}`);
    return info;
  }

  async function blendInfo(s) {
    const b = await describeBlend(workspace, s.blendId);
    return { ...b, path: b.dir, title: b.name, previewWith: s.previewWith === SPECIMEN_DIR ? 'specimen' : s.previewWith, lock: locks.status(path.join(library, s.blendId), s) };
  }

  // Where the editor reads and writes files.
  function editRoot(s) {
    if (s.mode === 'blend') return path.join(library, s.blendId);
    if (!s.brewDir) throw new HttpError(409, 'No Brew is open.');
    return s.brewDir;
  }
  const blendMode = (s) => s.mode === 'blend';
  function requireBrew(s) {
    if (s.mode !== 'brew' || !s.brewDir) throw new HttpError(409, 'Open a Brew for this.');
    return s.brewDir;
  }
  /** Every write goes through here: refuse if someone else holds the lock. */
  function requireEditable(s) {
    const target = lockTarget(s);
    if (!target) throw new HttpError(409, 'Nothing is open.');
    const st = locks.status(target, s);
    if (!st.editable) throw new HttpError(423, `Read-only: ${st.holder} is editing this.`, { locked: true, holder: st.holder });
    return target;
  }
  function inWorkspaceOnly(p) {
    if (serverMode && !insideWorkspace(workspace, p) && path.resolve(p) !== path.resolve(workspace)) throw new HttpError(403, 'In server mode only the workspace can be browsed.');
    return p;
  }
  function localOnly() {
    if (serverMode) throw new HttpError(403, 'Not available in server mode — it would run on the server, not your computer.');
  }

  async function brewList(s) {
    const brews = await listBrews(workspace);
    return Promise.all(brews.map(async (b) => ({ ...b, modified: await lastModified(b.path), editingBy: locks.holderFor(b.path, s.clientId) })));
  }

  async function importBrew(s, buffer, name) {
    const info = await unpackBrew(buffer, workspace, { name: name || undefined });
    log(`Imported ${info.path}`);
    await openBrew(s, info.path);
    return info;
  }

  async function deleteBrew(s, dir) {
    dir = path.resolve(dir || '');
    const holder = locks.holderFor(dir, s.clientId);
    if (holder) throw new HttpError(423, `${holder} is editing this Brew, so it can't be deleted now.`);
    // Close it everywhere it's open in this browser, so nothing holds its files.
    for (const other of sessions.values()) {
      if (other.mode === 'brew' && other.brewDir === dir) {
        await release(other);
        other.brewDir = null;
        if (other !== s) send(other, { type: 'closed', reason: 'deleted' });
      }
    }
    const meta = await trashBrew(workspace, dir);
    log(`Moved to trash: ${dir}`);
    return meta;
  }

  // A Brew named on the command line becomes what new tabs open first.
  if (brew) {
    if (!(await isBrew(path.resolve(brew)))) throw new Error(`Not a Brew (no brew.yaml): ${brew}`);
    await remember({ lastBrew: path.resolve(brew) });
  }

  const api = {
    'GET /api/state': async (s, _b, url) => {
      // A new tab: open the Brew in the URL, or the last one used.
      const wanted = url.searchParams.get('brew');
      if (!s.brewDir && !s.blendId && !url.searchParams.get('peek')) {
        const target = wanted || (await lastBrew());
        if (target) { try { await openBrew(s, target); } catch {} }
      }
      return {
        workspace,
        serverMode,
        user: s.user,
        mode: s.mode,
        brew: s.mode === 'brew' && s.brewDir ? { ...(await describeBrew(s.brewDir)), lock: locks.status(s.brewDir, s) } : null,
        blend: s.mode === 'blend' ? await blendInfo(s) : null,
      };
    },
    'GET /api/brews': async (s) => brewList(s),
    'GET /api/blends': async (_s, _b, url) => (await listLibrary(workspace)).filter((b) => url.searchParams.get('all') || !b.abstract),
    'POST /api/open': async (s, body) => openBrew(s, body.path),
    'POST /api/close': async (s) => { await release(s); Object.assign(s, { brewDir: null, blendId: null, mode: 'brew' }); return { ok: true }; },
    'POST /api/brews': async (s, body) => {
      const info = await createBrew(workspace, body);
      return openBrew(s, info.path);
    },
    'POST /api/samples': async () => restoreSamples(workspace),
    'POST /api/lock/take-over': async (s) => {
      const target = lockTarget(s);
      if (!target) throw new HttpError(409, 'Nothing is open.');
      const lost = locks.takeOver(target, s);
      for (const o of viewing(target)) {
        if (o.clientId === s.clientId) locks.acquire(target, o);
        send(o, { type: 'lock', lock: locks.status(target, o) });
      }
      void lost;
      log(`${s.user} took over ${target}`);
      return { editable: true, holder: null };
    },

    // Delete → trash (GitHub #4)
    'POST /api/brews/delete': async (s, body) => deleteBrew(s, body.path),
    'GET /api/trash': async () => listTrash(workspace),
    'POST /api/trash/restore': async (_s, body) => restoreTrash(workspace, body.id),
    'POST /api/trash/purge': async (_s, body) => purgeTrash(workspace, body.id),

    // .brew files
    'POST /api/pack': async (s) => {
      const r = await packBrew(requireBrew(s));
      log(`Packed ${r.file}`);
      return { ...r, url: `/s/${s.id}/preview/${DIST_DIR}/${encodeURIComponent(path.basename(r.file))}` };
    },
    'POST /api/import': async (s, _b, url, req) => importBrew(s, await readBody(req, MAX_BREW_BYTES), url.searchParams.get('name')),
    'POST /api/import-path': async (s, body) => {
      if (!String(body.path || '').toLowerCase().endsWith(BREW_EXT)) throw new HttpError(400, 'Choose a .brew file.');
      inWorkspaceOnly(body.path);
      return importBrew(s, await fs.readFile(body.path), null);
    },
    // AI support
    'GET /api/check': async (s) => checkBrew(requireBrew(s), { libraryDir: library }),
    'GET /api/context': async (s, _b, url) => ({
      text: await buildContext(requireBrew(s), { libraryDir: library, content: url.searchParams.get('content') !== '0', guide: url.searchParams.get('guide') !== '0' }),
    }),
    'POST /api/blend/adopt': async (s) => {
      requireEditable(s);
      const b = await adoptBrewBlend(workspace, requireBrew(s));
      return { blend: b, status: await blendStatus(library, s.brewDir) };
    },
    'GET /api/fs': async (_s, _b, url) => browse(inWorkspaceOnly(url.searchParams.get('path') || workspace)),
    'POST /api/export': async (s) => {
      const dir = requireBrew(s);
      const info = await describeBrew(dir);
      const name = `${slugify(info.title)}.pdf`;
      const out = path.join(dir, DIST_DIR, name);
      const result = await exportPdf(`${server.internalUrl}/s/${s.id}/preview/?mode=print${authRequired ? `&token=${encodeURIComponent(token)}` : ''}`, out);
      log(`Exported ${out} (${result.pages} pages, ${result.ms} ms)`);
      return { ...result, url: `/s/${s.id}/preview/${DIST_DIR}/${encodeURIComponent(name)}` };
    },

    // Editor files (Brew or Blend, depending on mode)
    'GET /api/files': async (s) => (blendMode(s) ? listBlendFiles(editRoot(s)) : listBrewFiles(editRoot(s))),
    'GET /api/file': async (s, _b, url) => {
      const f = await readBrewFile(editRoot(s), url.searchParams.get('path'), { blendMode: blendMode(s) });
      const st = locks.status(lockTarget(s), s);
      if (!st.editable) Object.assign(f, { readOnly: true, readOnlyReason: `Read-only · ${st.holder} is editing` });
      return f;
    },
    'PUT /api/file': async (s, body) => { requireEditable(s); return writeBrewFile(editRoot(s), body.path, body.content, body.baseMtime, { blendMode: blendMode(s) }); },
    'POST /api/chapters': async (s, body) => { requireEditable(s); return createChapter(requireBrew(s), body.title); },
    'POST /api/images': async (s, _b, url, req) => { requireEditable(s); return saveImage(requireBrew(s), url.searchParams.get('name') || '', await readBody(req, MAX_IMAGE_BYTES)); },

    // Inspector
    'GET /api/presets': async (s) => getPresets(blendMode(s) ? s.flatDir : path.join(requireBrew(s), BLEND_DIR)),
    'GET /api/style': async (s, _b, url) => getStyle(editRoot(s), url.searchParams.get('selector') || '', url.searchParams.get('file') || undefined),
    'POST /api/style': async (s, body) => { requireEditable(s); return setStyle(editRoot(s), body.selector, body.set, body.file || undefined); },
    'GET /api/attrs': async (s, _b, url) => getAttrs(requireBrew(s), Object.fromEntries(url.searchParams)),
    'POST /api/attrs': async (s, body) => { requireEditable(s); return setAttrs(requireBrew(s), body); },

    // Blend copy in a Brew vs. the Library
    'GET /api/blend/status': async (s) => blendStatus(library, requireBrew(s)),
    'GET /api/blend/diff': async (s) => blendDiff(library, requireBrew(s)),
    'POST /api/blend/update': async (s) => {
      requireEditable(s);
      const dir = requireBrew(s);
      const status = await blendStatus(library, dir);
      if (!status.source || status.state === 'missing') throw new HttpError(404, `Blend "${status.source}" isn't in the Library.`);
      await attachBlend(workspace, dir, status.source);
      return blendStatus(library, dir);
    },

    // Blend Editor
    'POST /api/blend/open': async (s, body) => openBlend(s, body.id, { previewWith: body.previewWith === 'specimen' ? SPECIMEN_DIR : body.previewWith }),
    'POST /api/blend/preview-with': async (s, body) => openBlend(s, s.blendId, { previewWith: body.path === 'specimen' ? SPECIMEN_DIR : body.path }),
    'POST /api/blend/create': async (s, body) => {
      const { id } = await createBlend(workspace, body);
      return openBlend(s, id);
    },
    'POST /api/blend/release': async (s, body) => {
      if (!blendMode(s)) throw new HttpError(409, 'Open a Blend in the Blend Editor first.');
      requireEditable(s);
      const r = await releaseBlend(workspace, s.blendId, body);
      return { ...r, blend: await blendInfo(s) };
    },

    'POST /api/reveal': async (s, body) => {
      localOnly();
      const target = body.path || (blendMode(s) ? editRoot(s) : s.brewDir);
      if (!target) throw new Error('Nothing to reveal.');
      reveal(target, body.app, Boolean(body.select));
      return { ok: true };
    },
  };

  // ── Auth (server mode) ────────────────────────────────────────────────────
  function authorized(req, url) {
    if (!authRequired) return true;
    if (url.searchParams.get('token') === token) return true;
    const cookie = /(?:^|;\s*)docubrew_token=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    return cookie && decodeURIComponent(cookie) === token;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname;

    if (!authorized(req, url)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'Access token required.' });
      return html(res, 401, loginPage());
    }
    // A valid ?token= sets the cookie, so the rest of the app (and PDF export) just works.
    if (authRequired && url.searchParams.get('token') === token) {
      res.setHeader('set-cookie', `docubrew_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        url.searchParams.delete('token');
        res.writeHead(302, { location: `/${url.search}` });
        return res.end();
      }
    }

    const route = api[`${req.method} ${p}`];
    if (route) {
      try {
        const s = getSession(req.headers['x-docubrew-session'] || url.searchParams.get('session'), {
          clientId: String(req.headers['x-docubrew-client'] || '').slice(0, 64) || undefined,
          user: serverMode ? decodeURIComponent(String(req.headers['x-docubrew-user'] || '')).trim().slice(0, 60) || undefined : localUser,
        });
        const raw = p === '/api/images' || p === '/api/import';
        const body = !raw && (req.method === 'POST' || req.method === 'PUT') ? await readJson(req) : {};
        return json(res, 200, await route(s, body, url, req));
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

    // Preview: /s/<session>/preview/… (each tab renders its own document)
    const m = /^\/s\/([\w-]{1,64})\/preview\/(.*)$/.exec(p);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) return html(res, 200, errorPage('This tab\'s session has ended. Reload the page.'));
      s.lastSeen = Date.now();
      const rel = m[2];
      if (rel === '' || rel === 'index.html') return renderPreview(s, res, url);
      let f = null;
      if (blendMode(s)) {
        // blend/… comes from the live flattened Blend; everything else from the preview content
        f = rel.startsWith(`${BLEND_DIR}/`) ? safeJoin(s.flatDir, rel.slice(BLEND_DIR.length + 1)) : safeJoin(s.previewWith, rel);
      } else if (s.brewDir) {
        f = safeJoin(s.brewDir, rel);
      }
      const layer = url.searchParams.get('layer');
      const ok = f && (await sendFile(res, f, layer && f.endsWith('.css') ? { transform: (css) => wrapLayer(css, layer) } : {}));
      return ok || notFound(res);
    }
    if (p === '/favicon.ico') return void ((await sendFile(res, path.join(APP_ROOT, 'app', 'favicon.svg'))) || notFound(res));
    notFound(res);
  }

  async function renderPreview(s, res, url) {
    const mode = url.searchParams.get('mode') === 'print' ? 'print' : 'preview';
    try {
      if (blendMode(s)) {
        const { html: doc } = await renderBrew(s.previewWith, { mode, blendDir: s.flatDir });
        return html(res, 200, doc);
      }
      if (!s.brewDir) return html(res, 200, errorPage('No Brew is open.'));
      const { html: doc } = await renderBrew(s.brewDir, { mode, vars: s.varsOverride });
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
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws' || !authorized(req, url)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = getSession(url.searchParams.get('session'), { clientId: url.searchParams.get('client') || undefined });
      s.sockets.add(ws);
      ws.on('close', () => { s.sockets.delete(ws); s.lastSeen = Date.now(); });
    });
  });

  const actualPort = await listen(server, port, host);
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  server.url = `http://${shownHost}:${actualPort}`;
  server.internalUrl = `http://${serverMode && (host === '0.0.0.0' || host === '::') ? '127.0.0.1' : host}:${actualPort}`;
  server.port = actualPort;
  server.serverMode = serverMode;
  server.token = authRequired ? token : null;
  server.networkUrls = serverMode ? lanAddresses().map((a) => `http://${a}:${actualPort}`) : [];
  // CLI helpers: one session for scripted builds
  const cli = () => getSession('cli');
  server.openBrew = (dir) => openBrew(cli(), dir);
  server.openBlend = (id, o) => openBlend(cli(), id, o);
  server.cliPreviewUrl = () => `${server.internalUrl}/s/cli/preview/?mode=print${authRequired ? `&token=${encodeURIComponent(token)}` : ''}`;
  Object.defineProperty(server, 'state', { get: () => cli() });
  const close = server.close.bind(server);
  server.close = async () => {
    clearInterval(sweeper);
    for (const s of [...sessions.values()]) await closeSession(s);
    await new Promise((r) => close(r));
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  };
  return server;
}

/** Most recent change to a Brew's own files (not dist/ or its Blend copy). */
async function lastModified(dir) {
  let latest = 0;
  async function walk(d, depth) {
    let entries = [];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (depth === 0 && ['dist', 'blend', '.git', 'node_modules'].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 2) await walk(full, depth + 1); }
      else {
        try { const st = await fs.stat(full); if (st.mtimeMs > latest) latest = st.mtimeMs; } catch {}
      }
    }
  }
  await walk(dir, 0);
  return latest ? new Date(latest).toISOString() : null;
}

async function savedToken(ws) {
  const file = path.join(ws, '.docubrew', 'server.json');
  try {
    const t = JSON.parse(await fs.readFile(file, 'utf8')).token;
    if (t) return t;
  } catch {}
  const t = randomBytes(18).toString('base64url');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ token: t }, null, 2));
  return t;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function loginPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>DocuBrew</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f7f4;color:#111;font:15px/1.5 Inter,system-ui,sans-serif}
form{width:340px}h1{font-size:22px;letter-spacing:-.02em;margin:0 0 6px}p{color:#5f5e5a;margin:0 0 18px}
input{width:100%;box-sizing:border-box;height:36px;border:1px solid #dddcd6;background:#f1f0ec;padding:0 10px;font:inherit;border-radius:2px}
button{margin-top:10px;height:34px;padding:0 14px;border:1px solid #111;background:#111;color:#f8f7f4;font:inherit;border-radius:2px;cursor:pointer}</style></head>
<body><form method="get" action="/"><h1>DocuBrew</h1><p>This DocuBrew server needs its access token. Ask whoever runs it, or use the link it printed when it started.</p>
<input name="token" placeholder="Access token" autocomplete="off" autofocus><button>Continue</button></form></body></html>`;
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

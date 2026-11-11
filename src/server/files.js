// Reading and writing files inside the open Brew, for the in-browser editor.
// The Brew's blend/ copy is read-only here (docs/DECISIONS.md D-008).
import fs from 'node:fs/promises';
import path from 'node:path';
import { BREW_FILE, BLEND_DIR, CONTENT_DIR, OVERRIDES_FILE, listChapters } from '../core/brew.js';
import { listFiles, slugify, sha256, exists } from '../core/util.js';
import { safeJoin } from './static.js';

const EDITABLE = /\.(md|markdown|ya?ml|css|html|txt)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function resolve(dir, rel) {
  const full = rel && safeJoin(dir, rel);
  if (!full) throw new HttpError(400, `Invalid path: ${rel}`);
  return full;
}

const isReadOnly = (rel) => rel === BLEND_DIR || rel.startsWith(`${BLEND_DIR}/`);
const toPosix = (p) => p.split(path.sep).join('/');

/** Files the editor can open in a Brew, grouped for the sidebar. */
export async function listBrewFiles(dir) {
  const chapters = await listChapters(dir);
  const blend = (await listFiles(path.join(dir, BLEND_DIR))).filter((f) => EDITABLE.test(f) && !f.startsWith('fonts/')).map((f) => `${BLEND_DIR}/${f}`);
  const item = (p, label = p, readOnly = false) => ({ path: p, label, readOnly });
  return {
    groups: [
      { id: 'document', files: [item(BREW_FILE), item(OVERRIDES_FILE)] },
      { id: 'chapters', label: 'Chapters', files: chapters.map((p) => item(p, p.replace(/^content\//, ''))) },
      { id: 'blend', label: 'Blend copy · read-only', collapsed: true, files: blend.map((p) => item(p, p.replace(/^blend\//, ''), true)) },
    ],
    defaultFile: chapters[0] || BREW_FILE,
  };
}

const LAYER_FILES = ['fonts.css', 'tokens.css', 'base.css', 'components.css', 'page.css', 'templates.css'];

/** Files of a Library Blend, for the Blend Editor. */
export async function listBlendFiles(dir) {
  const all = await listFiles(dir);
  const item = (p, label = p, missing = false) => ({ path: p, label, readOnly: false, missing });
  const layers = LAYER_FILES;
  const templates = all.filter((f) => f.startsWith('templates/') && EDITABLE.test(f));
  const other = all.filter((f) => EDITABLE.test(f) && f !== 'blend.yaml' && !layers.includes(f) && !templates.includes(f) && !f.startsWith('fonts/'));
  return {
    groups: [
      { id: 'manifest', files: [item('blend.yaml')] },
      // Every layer is listed; ones this Blend doesn't have yet are created on first save.
      { id: 'layers', label: 'Stylesheets', files: layers.map((f) => item(f, f, !all.includes(f))) },
      { id: 'templates', label: 'Templates', files: templates.map((f) => item(f, f.replace(/^templates\//, ''))) },
      ...(other.length ? [{ id: 'other', label: 'Other', files: other.map((f) => item(f)) }] : []),
    ],
    defaultFile: all.includes('base.css') ? 'base.css' : 'blend.yaml',
  };
}

export async function readBrewFile(dir, rel, { blendMode = false } = {}) {
  const full = resolve(dir, rel);
  if (!EDITABLE.test(full)) throw new HttpError(400, `Not a text file DocuBrew can edit: ${rel}`);
  let content, stat;
  try {
    [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
  } catch {
    // In the Blend Editor, a layer this Blend doesn't define yet opens empty and is created on save.
    if (blendMode && LAYER_FILES.includes(toPosix(rel))) {
      return { path: toPosix(rel), content: `/* ${rel}: added after the same layer of the Blend this one builds on. */\n`, mtime: null, readOnly: false, isNew: true };
    }
    throw new HttpError(404, `File not found: ${rel}`);
  }
  return { path: toPosix(rel), content, mtime: stat.mtimeMs, readOnly: !blendMode && isReadOnly(toPosix(rel)) };
}

/**
 * Save a file. `baseMtime` is the modification time the editor loaded; if the file changed on disk
 * since then (e.g. saved from VS Code), the save is refused with 409 and the disk version.
 */
export async function writeBrewFile(dir, rel, content, baseMtime, { blendMode = false } = {}) {
  rel = toPosix(rel);
  if (!blendMode && isReadOnly(rel)) throw new HttpError(403, 'The Blend copy is read-only. Put document styles in overrides.css.');
  if (rel.startsWith('dist/')) throw new HttpError(403, 'dist/ holds exported files.');
  const full = resolve(dir, rel);
  if (!EDITABLE.test(full)) throw new HttpError(400, `Not a text file DocuBrew can edit: ${rel}`);
  if (typeof content !== 'string') throw new HttpError(400, 'Missing content.');

  if (baseMtime != null && (await exists(full))) {
    const stat = await fs.stat(full);
    if (Math.abs(stat.mtimeMs - baseMtime) > 1) {
      const disk = await fs.readFile(full, 'utf8');
      if (disk !== content) throw new HttpError(409, `${rel} changed on disk.`, { conflict: true, content: disk, mtime: stat.mtimeMs });
    }
  }
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  const stat = await fs.stat(full);
  return { path: rel, mtime: stat.mtimeMs };
}

/** Add the next numbered chapter file. */
export async function createChapter(dir, title) {
  title = String(title || '').trim() || 'New chapter';
  const existing = await listChapters(dir);
  const numbers = existing.map((f) => parseInt(path.basename(f), 10)).filter((n) => !Number.isNaN(n));
  const next = String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(2, '0');
  const rel = `${CONTENT_DIR}/${next}-${slugify(title)}.md`;
  const full = resolve(dir, rel);
  if (await exists(full)) throw new HttpError(409, `${rel} already exists.`);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const yamlTitle = /[:#"'{}\[\],&*!|>%@`]/.test(title) ? JSON.stringify(title) : title;
  await fs.writeFile(full, `---\ntitle: ${yamlTitle}\n---\n\n`);
  return { path: rel };
}

/**
 * Save an uploaded image into images/. Same name + same bytes → reuse; same name, different bytes → name-2.ext.
 * Returns the path relative to the Brew.
 */
export async function saveImage(dir, originalName, buffer) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (!IMAGE.test(ext)) throw new HttpError(400, `Unsupported image type: ${ext || 'unknown'}. Use PNG, JPG, GIF, WebP, SVG or AVIF.`);
  if (!buffer.length) throw new HttpError(400, 'Empty file.');
  const base = slugify(path.basename(originalName, path.extname(originalName))) || 'image';
  const folder = path.join(dir, 'images');
  await fs.mkdir(folder, { recursive: true });
  const hash = sha256(buffer);
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? `${base}${ext === '.jpeg' ? '.jpg' : ext}` : `${base}-${i}${ext === '.jpeg' ? '.jpg' : ext}`;
    const full = path.join(folder, name);
    if (!(await exists(full))) {
      await fs.writeFile(full, buffer);
      return { path: `images/${name}`, reused: false };
    }
    if (sha256(await fs.readFile(full)) === hash) return { path: `images/${name}`, reused: true };
  }
  throw new HttpError(500, 'Too many images with the same name.');
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `File is larger than ${Math.round(limit / 1024 / 1024)} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

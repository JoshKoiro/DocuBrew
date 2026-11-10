// Small shared helpers. No dependencies.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge plain objects. Arrays and scalars from `b` replace those in `a`. */
export function deepMerge(a, b) {
  if (!isPlainObject(a)) return structuredClone(b);
  if (!isPlainObject(b)) return b === undefined ? structuredClone(a) : b;
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

/** Read a dotted path ("machine.serial") from an object. */
export function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

/** Recursively list files under `dir`, returning paths relative to it (forward slashes). */
export async function listFiles(dir, { skip = [] } = {}) {
  const out = [];
  async function walk(d, rel) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip.includes(r) || skip.includes(e.name)) continue;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  }
  await walk(dir, '');
  return out.sort();
}

export async function copyFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

/** Copy a directory tree. Existing files are overwritten. */
export async function copyDir(src, dest) {
  for (const rel of await listFiles(src)) {
    await copyFile(path.join(src, rel), path.join(dest, rel));
  }
}

export function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

/** Split YAML front matter from a Markdown string. Returns { data, body, offset }. */
export function splitFrontMatter(text, parseYaml) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text, offset: 0 };
  const offset = m[0].split('\n').length - 1;
  return { data: parseYaml(m[1]) || {}, body: text.slice(m[0].length), offset };
}

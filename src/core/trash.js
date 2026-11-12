// Deleting a Brew from the app (GitHub #4) moves it to <workspace>/.docubrew/trash/ instead of erasing it,
// so a misclick can be undone. Blends are only deleted through the file system, by design.
import fs from 'node:fs/promises';
import path from 'node:path';
import { isBrew, describeBrew } from './brew.js';
import { exists, slugify } from './util.js';
import { LIBRARY_DIR } from './workspace.js';

const trashDir = (ws) => path.join(ws, '.docubrew', 'trash');

/** Is `dir` a Brew folder directly inside the workspace (not the workspace, Library or a hidden folder)? */
export function insideWorkspace(ws, dir) {
  const rel = path.relative(path.resolve(ws), path.resolve(dir));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Windows can briefly hold files open (file watchers, antivirus) after a folder is closed.
async function move(src, dest) {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      const busy = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(err.code);
      if (err.code === 'EXDEV' || (busy && i >= 11)) break; // fall back to copy + delete
      if (!busy) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  await fs.cp(src, dest, { recursive: true });
  await fs.rm(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export async function trashBrew(ws, dir) {
  dir = path.resolve(dir);
  if (!insideWorkspace(ws, dir)) throw new Error('Only Brews in your workspace can be deleted here.');
  const rel = path.relative(path.resolve(ws), dir);
  if (rel.split(path.sep)[0] === LIBRARY_DIR || rel.startsWith('.')) throw new Error('That folder can\'t be deleted from DocuBrew.');
  if (!(await isBrew(dir))) throw new Error('Not a Brew.');
  const info = await describeBrew(dir);
  const id = `${slugify(path.basename(dir))}--${Date.now()}`;
  await fs.mkdir(trashDir(ws), { recursive: true });
  await move(dir, path.join(trashDir(ws), id));
  const meta = { id, folder: path.basename(dir), title: info.title, original: dir, deletedAt: new Date().toISOString() };
  await fs.writeFile(path.join(trashDir(ws), `${id}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

export async function listTrash(ws) {
  let names = [];
  try { names = await fs.readdir(trashDir(ws)); } catch { return []; }
  const items = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(trashDir(ws), n), 'utf8'));
      if (await exists(path.join(trashDir(ws), meta.id))) items.push(meta);
    } catch {}
  }
  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

function trashItem(ws, id) {
  if (!/^[\w.-]+--\d+$/.test(id || '')) throw new Error('Unknown trash item.');
  return path.join(trashDir(ws), id);
}

/** Put a trashed Brew back — under its old folder name, or name-2 if that's been taken since. */
export async function restoreTrash(ws, id) {
  const src = trashItem(ws, id);
  const meta = JSON.parse(await fs.readFile(`${src}.json`, 'utf8'));
  let dest = path.join(ws, meta.folder);
  for (let i = 2; await exists(dest); i++) dest = path.join(ws, `${meta.folder}-${i}`);
  await move(src, dest);
  await fs.rm(`${src}.json`, { force: true });
  return describeBrew(dest);
}

/** Erase a trashed Brew for good. */
export async function purgeTrash(ws, id) {
  const src = trashItem(ws, id);
  await fs.rm(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await fs.rm(`${src}.json`, { force: true });
  return { id };
}

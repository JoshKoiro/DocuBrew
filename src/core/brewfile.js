// .brew files: a whole Brew (content, images, its Blend copy, overrides) in one zip, for sending
// to someone or archiving. See docs/DECISIONS.md D-003.
//
//   manifest.json   { format: "docubrew-brew", formatVersion, name, title, blend, created, docubrew }
//   brew.yaml, content/…, images/…, blend/…, overrides.css …
//
// dist/ (exported files), .git and other tool folders are left out.
import fs from 'node:fs/promises';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { readBrewManifest, describeBrew, BREW_FILE, DIST_DIR } from './brew.js';
import { listFiles, slugify, exists } from './util.js';
import { APP_ROOT } from './workspace.js';

export const BREW_EXT = '.brew';
const FORMAT = 'docubrew-brew';
const FORMAT_VERSION = 1;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.docubrew', '.vscode', '.idea']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const STORED = /\.(png|jpe?g|gif|webp|avif|woff2?|pdf|zip)$/i; // already compressed

// Limits for files received from someone else.
const MAX_ENTRIES = 5000;
const MAX_UNPACKED = 1024 * 1024 * 1024; // 1 GB

let appVersion = null;
async function docubrewVersion() {
  if (!appVersion) {
    try { appVersion = JSON.parse(await fs.readFile(path.join(APP_ROOT, 'package.json'), 'utf8')).version; } catch { appVersion = 'unknown'; }
  }
  return appVersion;
}

/** Files that go into a .brew, relative to the Brew folder. */
async function packList(dir) {
  const all = await listFiles(dir);
  return all.filter((rel) => {
    const parts = rel.split('/');
    if (parts[0] === DIST_DIR) return false;
    if (parts.some((p) => SKIP_DIRS.has(p))) return false;
    return !SKIP_FILES.has(parts[parts.length - 1]);
  });
}

/**
 * Zip a Brew folder into a .brew file.
 * @returns {{ file, bytes, files }}
 */
export async function packBrew(dir, outFile) {
  dir = path.resolve(dir);
  const manifest = await readBrewManifest(dir); // throws if not a Brew
  const title = manifest.title || path.basename(dir);
  outFile = outFile ? path.resolve(outFile) : path.join(dir, DIST_DIR, `${slugify(title)}${BREW_EXT}`);

  const entries = {};
  const files = await packList(dir);
  for (const rel of files) {
    const data = await fs.readFile(path.join(dir, rel));
    entries[rel] = STORED.test(rel) ? [data, { level: 0 }] : data;
  }
  const blend = typeof manifest.blend === 'string' ? { source: manifest.blend } : manifest.blend || null;
  entries['manifest.json'] = strToU8(JSON.stringify({
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    name: path.basename(dir),
    title,
    blend: blend ? { source: blend.source, version: blend.version } : null,
    created: new Date().toISOString(),
    docubrew: await docubrewVersion(),
    files: files.length,
  }, null, 2));

  const zipped = zipSync(entries, { level: 6, mtime: new Date() });
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, zipped);
  return { file: outFile, bytes: zipped.length, files: files.length };
}

/** Validate an entry name and return it as a safe relative path, or null to skip it. */
function safeEntry(name) {
  const n = name.replace(/\\/g, '/');
  if (n.endsWith('/')) return null; // directory entry
  if (n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').some((p) => p === '..' || p === '')) {
    throw new Error(`This .brew contains an unsafe path ("${name}") and was not imported.`);
  }
  return n;
}

/** Read and check a .brew without writing anything. Returns { manifest, files: Map(rel → bytes) }. */
export function readBrewFile(buffer) {
  let count = 0;
  let total = 0;
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer), {
      filter(f) {
        if (++count > MAX_ENTRIES) throw new Error(`This .brew has more than ${MAX_ENTRIES} files.`);
        total += f.originalSize;
        if (total > MAX_UNPACKED) throw new Error('This .brew unpacks to more than 1 GB.');
        return true;
      },
    });
  } catch (err) {
    if (/\.brew/.test(err.message)) throw err;
    throw new Error(`Not a valid .brew file (${err.message}).`);
  }
  if (!files['manifest.json']) throw new Error('Not a .brew file: manifest.json is missing.');
  let manifest;
  try { manifest = JSON.parse(strFromU8(files['manifest.json'])); } catch { throw new Error('Not a .brew file: manifest.json is unreadable.'); }
  if (manifest.format !== FORMAT) throw new Error('Not a .brew file: unknown format.');
  if (manifest.formatVersion > FORMAT_VERSION) throw new Error(`This .brew was made by a newer DocuBrew (format ${manifest.formatVersion}). Update DocuBrew to open it.`);
  if (!files[BREW_FILE]) throw new Error('This .brew has no brew.yaml.');

  const out = new Map();
  for (const [name, data] of Object.entries(files)) {
    if (name === 'manifest.json') continue;
    const rel = safeEntry(name);
    if (rel) out.set(rel, data);
  }
  return { manifest, files: out };
}

/** Pick a folder name in `parent` that isn't taken: name, name-2, name-3 … */
export async function uniqueFolder(parent, name) {
  const base = slugify(name) || 'imported-brew';
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (!(await exists(path.join(parent, candidate)))) return candidate;
  }
  throw new Error('Could not find a free folder name.');
}

/**
 * Unpack a .brew into `parentDir` as a new Brew folder.
 * @returns describeBrew() of the new folder, plus `renamed` if the name was taken.
 */
export async function unpackBrew(buffer, parentDir, { name } = {}) {
  const { manifest, files } = readBrewFile(buffer); // validates everything before writing
  const wanted = name || manifest.name || manifest.title;
  const folder = await uniqueFolder(parentDir, wanted);
  const dir = path.join(parentDir, folder);
  for (const [rel, data] of files) {
    const dest = path.join(dir, ...rel.split('/'));
    if (!dest.startsWith(dir + path.sep)) throw new Error(`Unsafe path in .brew: ${rel}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
  }
  const info = await describeBrew(dir);
  return { ...info, renamed: folder !== slugify(wanted) ? folder : null, manifest };
}

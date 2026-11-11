// The workspace: ~/Documents/DocuBrew by default. Holds the Blend Library (Blends/) and Brew folders.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { exists, copyDir, slugify } from './util.js';
import { flattenBlend, listBlends, resolveChain, readBlendManifest, LAYERS } from './blend.js';
import { isBrew, describeBrew, BREW_FILE, BLEND_DIR, OVERRIDES_FILE } from './brew.js';
import { hashDir } from './blend-status.js';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LIBRARY_DIR = 'Blends';

export function defaultWorkspace() {
  return path.join(os.homedir(), 'Documents', 'DocuBrew');
}

export function resolveWorkspace(explicit) {
  return path.resolve(explicit || process.env.DOCUBREW_WORKSPACE || defaultWorkspace());
}

export const libraryDir = (ws) => path.join(ws, LIBRARY_DIR);

/**
 * Create the workspace if needed and seed it with the bundled Blends and sample Brew.
 * Existing Blends and Brews are never overwritten.
 */
export async function ensureWorkspace(ws) {
  const fresh = !(await exists(ws));
  await fs.mkdir(libraryDir(ws), { recursive: true });

  const bundledBlends = path.join(APP_ROOT, 'blends');
  for (const name of await safeReaddir(bundledBlends)) {
    const dest = path.join(libraryDir(ws), name);
    if (!(await exists(dest))) await copyDir(path.join(bundledBlends, name), dest);
  }

  if (fresh) await restoreSamples(ws);
  return { fresh };
}

/** Copy any bundled sample Brews that aren't in the workspace (by folder name). Returns the ones added. */
export async function restoreSamples(ws) {
  await fs.mkdir(libraryDir(ws), { recursive: true });
  // Samples need their Blends; put back any bundled Blend that's missing too.
  const bundledBlends = path.join(APP_ROOT, 'blends');
  for (const name of await safeReaddir(bundledBlends)) {
    const dest = path.join(libraryDir(ws), name);
    if (!(await exists(dest))) await copyDir(path.join(bundledBlends, name), dest);
  }
  const added = [];
  const examples = path.join(APP_ROOT, 'examples');
  for (const name of await safeReaddir(examples)) {
    const dest = path.join(ws, name);
    if (await exists(dest)) continue;
    await copyDir(path.join(examples, name), dest);
    // Samples ship without a blend copy; give them one from the Library.
    const manifest = YAML.parse(await fs.readFile(path.join(dest, BREW_FILE), 'utf8'));
    const id = typeof manifest.blend === 'string' ? manifest.blend : manifest.blend?.source;
    if (id) await attachBlend(ws, dest, id);
    added.push(await describeBrew(dest));
  }
  return added;
}

/** Replace a Library Blend with the version bundled with DocuBrew (only bundled Blends). */
export async function resetBundledBlend(ws, id) {
  const src = path.join(APP_ROOT, 'blends', id);
  if (!(await exists(path.join(src, 'blend.yaml')))) throw new Error(`"${id}" isn't a Blend bundled with DocuBrew.`);
  const dest = path.join(libraryDir(ws), id);
  await fs.rm(dest, { recursive: true, force: true });
  await copyDir(src, dest);
  return describeBlend(ws, id);
}

/** Start a new Library Blend, optionally extending another. */
export async function createBlend(ws, { name, extends: parent, description = '' }) {
  if (!name?.trim()) throw new Error('A name is required.');
  const id = slugify(name);
  const dir = path.join(libraryDir(ws), id);
  if (await exists(dir)) throw new Error(`A Blend named "${id}" already exists.`);
  if (parent) await resolveChain(libraryDir(ws), parent);
  await fs.mkdir(path.join(dir, 'templates'), { recursive: true });
  const manifest = { name: name.trim(), version: '0.1.0', ...(parent ? { extends: parent } : {}), description };
  if (!parent) manifest.page = { size: 'letter', margin: '0.8in' };
  await fs.writeFile(path.join(dir, 'blend.yaml'), YAML.stringify(manifest));
  const notes = {
    tokens: 'Global variables: colors, fonts, type scale, spacing.',
    base: 'Plain elements as Markdown produces them: headings, paragraphs, lists, tables.',
    components: 'Named pieces: callouts, figure presets, step lists.',
    page: 'Margins: headers, footers, page numbers, named pages.',
    templates: 'Title page, table of contents, chapter openers.',
  };
  for (const layer of LAYERS) {
    await fs.writeFile(path.join(dir, `${layer}.css`), `/* ── ${layer[0].toUpperCase()}${layer.slice(1)} ── ${notes[layer]}${parent ? `
   Added after ${parent}'s ${layer}.css.` : ''} */
`);
  }
  return { id, dir };
}

/** Bump a Library Blend's version and record a changelog entry in blend.yaml. */
export async function releaseBlend(ws, id, { bump = 'patch', note = '' } = {}) {
  const file = path.join(libraryDir(ws), id, 'blend.yaml');
  const doc = YAML.parseDocument(await fs.readFile(file, 'utf8'));
  const [maj, min, pat] = String(doc.get('version') || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  const version = bump === 'major' ? `${maj + 1}.0.0` : bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  doc.set('version', version);
  const entry = doc.createNode({ version, date: new Date().toISOString().slice(0, 10), ...(note.trim() ? { note: note.trim() } : {}) });
  const log = doc.get('changelog');
  if (log && YAML.isSeq(log)) log.items.unshift(entry);
  else doc.set('changelog', doc.createNode([entry.toJSON()]));
  await fs.writeFile(file, doc.toString());
  return { id, version };
}

export async function describeBlend(ws, id) {
  const dir = path.join(libraryDir(ws), id);
  const m = await readBlendManifest(dir);
  const chain = (await resolveChain(libraryDir(ws), id)).map((c) => c.id);
  return { id, dir, name: m.name || id, version: m.version || '0.0.0', description: m.description || '', extends: m.extends || null, abstract: Boolean(m.abstract), chain, changelog: m.changelog || [] };
}

async function safeReaddir(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function listBrews(ws) {
  const brews = [];
  for (const name of await safeReaddir(ws)) {
    if (name === LIBRARY_DIR || name.startsWith('.')) continue;
    const dir = path.join(ws, name);
    if (await isBrew(dir)) {
      try { brews.push(await describeBrew(dir)); } catch (err) { brews.push({ path: dir, folder: name, title: name, error: err.message }); }
    }
  }
  return brews.sort((a, b) => a.title.localeCompare(b.title));
}

export async function listLibrary(ws) {
  return listBlends(libraryDir(ws));
}

/** Copy a Library Blend into a Brew and record where it came from in brew.yaml. */
export async function attachBlend(ws, brewDir, blendId) {
  const provenance = await flattenBlend(libraryDir(ws), blendId, path.join(brewDir, BLEND_DIR));
  provenance.copyHash = await hashDir(path.join(brewDir, BLEND_DIR));
  const file = path.join(brewDir, BREW_FILE);
  const doc = YAML.parseDocument(await fs.readFile(file, 'utf8'));
  doc.set('blend', provenance);
  await fs.writeFile(file, doc.toString());
  return provenance;
}

/** Create a new Brew folder in the workspace. */
export async function createBrew(ws, { title, folder, blend }) {
  if (!title?.trim()) throw new Error('A title is required.');
  if (!blend) throw new Error('Pick a Blend.');
  const name = slugify(folder || title);
  const dir = path.join(ws, name);
  if (await exists(dir)) throw new Error(`A folder named "${name}" already exists in the workspace.`);
  await resolveChain(libraryDir(ws), blend); // fail before creating anything if the Blend is missing

  await fs.mkdir(path.join(dir, 'content'), { recursive: true });
  await fs.mkdir(path.join(dir, 'images'), { recursive: true });

  const manifest = {
    title: title.trim(),
    subtitle: '',
    author: '',
    revision: 'A',
    date: new Date().toISOString().slice(0, 10),
    variables: {},
  };
  await fs.writeFile(path.join(dir, BREW_FILE), YAML.stringify(manifest));
  await fs.writeFile(
    path.join(dir, 'content', '01-introduction.md'),
    `---\ntitle: Introduction\n---\n\nStart writing here. Each Markdown file in \`content/\` is a chapter, in filename order.\n`
  );
  await fs.writeFile(
    path.join(dir, OVERRIDES_FILE),
    `/* Styles for this document only. Wrapped in @layer document, so they win over the Blend.\n   The Blend copy in blend/ is managed by DocuBrew — edit the Library Blend instead. */\n`
  );
  await fs.writeFile(path.join(dir, '.gitignore'), 'dist/\n');
  await attachBlend(ws, dir, blend);
  return describeBrew(dir);
}

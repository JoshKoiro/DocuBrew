// Brews: document projects. A folder is a Brew if it contains brew.yaml.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { exists, deepMerge } from './util.js';
import { readBlendManifest } from './blend.js';

export const BREW_FILE = 'brew.yaml';
export const CONTENT_DIR = 'content';
export const BLEND_DIR = 'blend';
export const OVERRIDES_FILE = 'overrides.css';
export const DIST_DIR = 'dist';

export async function isBrew(dir) {
  return exists(path.join(dir, BREW_FILE));
}

export async function readBrewManifest(dir) {
  const file = path.join(dir, BREW_FILE);
  const text = await fs.readFile(file, 'utf8');
  try {
    return YAML.parse(text) || {};
  } catch (err) {
    throw new Error(`Could not read ${BREW_FILE}: ${err.message}`);
  }
}

/** Chapter files: content/*.md in filename order. */
export async function listChapters(dir) {
  let names = [];
  try { names = await fs.readdir(path.join(dir, CONTENT_DIR)); } catch { return []; }
  return names
    .filter((n) => n.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((n) => `${CONTENT_DIR}/${n}`);
}

/** Everything needed to render or describe a Brew. */
export async function loadBrew(dir, { blendDir = path.join(dir, BLEND_DIR) } = {}) {
  const manifest = await readBrewManifest(dir);
  const blend = (await exists(path.join(blendDir, 'blend.yaml'))) ? await readBlendManifest(blendDir) : null;
  const chapters = await listChapters(dir);

  // Page setup: Blend defaults, then Brew overrides.
  const page = deepMerge(blend?.page || {}, manifest.page || {});

  // Variables available to Markdown and templates.
  const vars = deepMerge(blend?.variables || {}, manifest.variables || {});
  const doc = {
    title: manifest.title || path.basename(dir),
    subtitle: manifest.subtitle || '',
    author: manifest.author || '',
    revision: manifest.revision ?? '',
    date: manifest.date ?? '',
    ...vars,
    // keep these addressable as {{ doc.* }} even if a variable shadows them
    doc: { title: manifest.title || path.basename(dir), subtitle: manifest.subtitle || '', author: manifest.author || '', revision: manifest.revision ?? '', date: manifest.date ?? '' },
    brew: manifest,
    blend: blend ? { name: blend.name, version: blend.version } : null,
  };

  return { dir, manifest, blend, page, vars: doc, chapters };
}

/** A short description for the UI. */
export async function describeBrew(dir) {
  const m = await readBrewManifest(dir);
  return {
    path: dir,
    folder: path.basename(dir),
    title: m.title || path.basename(dir),
    blend: m.blend || null,
    chapters: (await listChapters(dir)).length,
  };
}

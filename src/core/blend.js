// Blends: reusable, layered styles that live in the workspace Library (Blends/)
// and are copied — flattened — into each Brew. See docs/DECISIONS.md D-004.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { deepMerge, exists, listFiles, copyFile, sha256 } from './util.js';

/** Stylesheet layers, in cascade order. `document` is the Brew's overrides.css. */
export const LAYERS = ['tokens', 'base', 'components', 'page', 'templates'];
export const LAYER_ORDER = [...LAYERS, 'document'];

/** Unlayered stylesheet for @font-face rules. */
export const FONTS_FILE = 'fonts.css';

const MANIFEST = 'blend.yaml';
const layerFile = (layer) => `${layer}.css`;

export async function readBlendManifest(dir) {
  const file = path.join(dir, MANIFEST);
  const text = await fs.readFile(file, 'utf8');
  try {
    return YAML.parse(text) || {};
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err.message}`);
  }
}

export async function isBlend(dir) {
  return exists(path.join(dir, MANIFEST));
}

/** List Blends in the Library with their manifest summary. */
export async function listBlends(libraryDir) {
  let entries = [];
  try { entries = await fs.readdir(libraryDir, { withFileTypes: true }); } catch { return []; }
  const blends = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(libraryDir, e.name);
    if (!(await isBlend(dir))) continue;
    try {
      const m = await readBlendManifest(dir);
      blends.push({
        id: e.name,
        name: m.name || e.name,
        version: m.version || '0.0.0',
        description: m.description || '',
        extends: m.extends || null,
        abstract: Boolean(m.abstract),
      });
    } catch (err) {
      blends.push({ id: e.name, name: e.name, error: err.message });
    }
  }
  return blends.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve the `extends` chain for a Library Blend. Returns dirs from root ancestor to the Blend itself. */
export async function resolveChain(libraryDir, id) {
  const chain = [];
  const seen = new Set();
  let current = id;
  while (current) {
    if (seen.has(current)) throw new Error(`Blend "${id}" has a circular extends chain: ${[...seen, current].join(' → ')}`);
    seen.add(current);
    const dir = path.join(libraryDir, current);
    if (!(await isBlend(dir))) throw new Error(`Blend "${current}" not found in ${libraryDir}`);
    const manifest = await readBlendManifest(dir);
    chain.unshift({ id: current, dir, manifest });
    current = manifest.extends || null;
  }
  return chain;
}

/** Content hash of a Blend and everything it extends — used to detect Library changes. */
export async function hashBlend(libraryDir, id) {
  const chain = await resolveChain(libraryDir, id);
  const parts = [];
  for (const { id: cid, dir } of chain) {
    for (const rel of await listFiles(dir)) {
      parts.push(`${cid}/${rel}\n`, await fs.readFile(path.join(dir, rel)));
    }
  }
  return sha256(...parts).slice(0, 16);
}

/**
 * Copy a Library Blend into `destDir`, flattening its extends chain:
 *  - layer CSS files and fonts.css are concatenated, ancestor first
 *  - blend.yaml manifests are deep-merged (descendant wins)
 *  - every other file (templates/, fonts/, assets) is copied, descendant overwriting ancestor
 * Returns provenance for brew.yaml: { source, version, hash }.
 */
export async function flattenBlend(libraryDir, id, destDir) {
  const chain = await resolveChain(libraryDir, id);
  const concatenated = new Set([...LAYERS.map(layerFile), FONTS_FILE]);

  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(destDir, { recursive: true });

  let manifest = {};
  for (const { dir, manifest: m } of chain) {
    manifest = deepMerge(manifest, m);
    for (const rel of await listFiles(dir)) {
      if (rel === MANIFEST || concatenated.has(rel)) continue;
      await copyFile(path.join(dir, rel), path.join(destDir, rel));
    }
  }

  for (const name of concatenated) {
    const pieces = [];
    for (const { id: cid, dir } of chain) {
      const file = path.join(dir, name);
      if (await exists(file)) {
        pieces.push(`/* ── from blend: ${cid} ─────────────────────────── */\n${await fs.readFile(file, 'utf8')}`);
      }
    }
    if (pieces.length) await fs.writeFile(path.join(destDir, name), pieces.join('\n\n'));
  }

  const leaf = chain[chain.length - 1];
  const hash = await hashBlend(libraryDir, id);
  delete manifest.extends;
  delete manifest.abstract;
  manifest.name = leaf.manifest.name || id;
  manifest.version = leaf.manifest.version || '0.0.0';
  manifest.flattenedFrom = chain.map((c) => c.id);

  const header = '# Copied from the Blend Library by DocuBrew. Edit the Library Blend, not this copy.\n';
  await fs.writeFile(path.join(destDir, MANIFEST), header + YAML.stringify(manifest, { lineWidth: 0 }));

  return { source: id, version: manifest.version, hash };
}

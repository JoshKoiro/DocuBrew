// Is a Brew's copy of its Blend still the same as the Library version? (docs/DECISIONS.md D-004)
//
// brew.yaml records, at copy time:
//   blend.hash      content hash of the Library Blend (and everything it extends)
//   blend.copyHash  content hash of the copy written into the Brew's blend/ folder
// Comparing them with today's hashes tells us whether the Library changed (update available)
// and whether someone edited the copy by hand (an update would replace those edits).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { hashBlend, flattenBlend, readBlendManifest } from './blend.js';
import { readBrewManifest, BLEND_DIR } from './brew.js';
import { listFiles, sha256, exists } from './util.js';

const TEXT = /\.(css|html|ya?ml|md|txt|json|svg)$/i;

export async function hashDir(dir) {
  const parts = [];
  for (const rel of await listFiles(dir)) parts.push(`${rel}\n`, await fs.readFile(path.join(dir, rel)));
  return sha256(...parts).slice(0, 16);
}

export async function blendStatus(libraryDir, brewDir) {
  const manifest = await readBrewManifest(brewDir);
  const info = typeof manifest.blend === 'string' ? { source: manifest.blend } : manifest.blend || {};
  if (!info.source) return { state: 'none' };
  const libDir = path.join(libraryDir, info.source);
  if (!(await exists(path.join(libDir, 'blend.yaml')))) {
    return { state: 'missing', source: info.source, version: info.version || null };
  }
  const lib = await readBlendManifest(libDir);
  const libraryHash = await hashBlend(libraryDir, info.source);
  const copyDir = path.join(brewDir, BLEND_DIR);
  const hasCopy = await exists(path.join(copyDir, 'blend.yaml'));
  const currentCopyHash = hasCopy ? await hashDir(copyDir) : null;
  const locallyModified = Boolean(info.copyHash && currentCopyHash && info.copyHash !== currentCopyHash);
  const outOfDate = !hasCopy || info.hash !== libraryHash;
  return {
    state: outOfDate ? 'out-of-date' : 'current',
    source: info.source,
    name: lib.name || info.source,
    version: info.version || null,
    libraryVersion: lib.version || null,
    libraryHash,
    locallyModified,
    // Brews made before copyHash existed can't tell; say so rather than guess.
    modificationUnknown: !info.copyHash,
  };
}

/** File-by-file differences between the Brew's copy and what an update would write. */
export async function blendDiff(libraryDir, brewDir) {
  const manifest = await readBrewManifest(brewDir);
  const source = typeof manifest.blend === 'string' ? manifest.blend : manifest.blend?.source;
  if (!source) throw new Error('This Brew has no Blend.');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'docubrew-diff-'));
  try {
    await flattenBlend(libraryDir, source, tmp);
    const copyDir = path.join(brewDir, BLEND_DIR);
    const a = new Set(await listFiles(copyDir));
    const b = new Set(await listFiles(tmp));
    const files = [];
    for (const rel of [...new Set([...a, ...b])].sort()) {
      const inCopy = a.has(rel);
      const inLib = b.has(rel);
      const before = inCopy ? await fs.readFile(path.join(copyDir, rel)) : Buffer.alloc(0);
      const after = inLib ? await fs.readFile(path.join(tmp, rel)) : Buffer.alloc(0);
      if (inCopy && inLib && before.equals(after)) continue;
      const status = !inCopy ? 'added' : !inLib ? 'removed' : 'changed';
      const binary = !TEXT.test(rel);
      const patch = binary ? null : createTwoFilesPatch(`brew/${rel}`, `library/${rel}`, before.toString('utf8'), after.toString('utf8'), '', '', { context: 3 });
      files.push({ path: rel, status, binary, patch });
    }
    return { source, files };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

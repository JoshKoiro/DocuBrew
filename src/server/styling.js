// Inspector back end: Blend presets, overrides.css rules, and Markdown attributes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { OVERRIDES_FILE } from '../core/brew.js';
import { readBlendManifest } from '../core/blend.js';
import { getRule, setRule, listRules } from '../core/overrides.js';
import { editBlockAttrs, readBlockAttrs, ATTR_KINDS } from '../core/attrs.js';
import { HttpError } from './files.js';
import { safeJoin } from './static.js';

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return ''; }
}

/** Presets from the Brew's Blend copy: { figure: [{class, label}], table: [...], ... } */
export async function getPresets(brewDir) {
  try {
    const m = await readBlendManifest(path.join(brewDir, 'blend'));
    return m.presets || {};
  } catch {
    return {};
  }
}

export async function getStyle(brewDir, selector) {
  const css = await readText(path.join(brewDir, OVERRIDES_FILE));
  return { selector, decls: getRule(css, selector), rules: listRules(css) };
}

export async function setStyle(brewDir, selector, changes) {
  const file = path.join(brewDir, OVERRIDES_FILE);
  const css = await readText(file);
  let next;
  try {
    next = setRule(css, selector, changes || {});
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  if (next !== css) await fs.writeFile(file, next);
  return { selector, decls: getRule(next, selector) };
}

function mdFile(brewDir, rel) {
  if (!/^content\/[^/]+\.md$/i.test(rel || '')) throw new HttpError(400, 'Attributes can only be edited in chapter files.');
  const full = safeJoin(brewDir, rel);
  if (!full) throw new HttpError(400, `Invalid path: ${rel}`);
  return full;
}

export async function getAttrs(brewDir, { file, line, end, kind }) {
  if (!ATTR_KINDS.includes(kind)) return { supported: false, id: null, classes: [] };
  const text = await fs.readFile(mdFile(brewDir, file), 'utf8');
  return { supported: true, ...readBlockAttrs(text, { line: Number(line), end: Number(end), kind }) };
}

/**
 * body: { file, line, end, kind, addClasses?: [], removeClasses?: [], id?: string|null }
 * `id` undefined leaves the id alone; null removes it.
 */
export async function setAttrs(brewDir, body) {
  const full = mdFile(brewDir, body.file);
  const text = await fs.readFile(full, 'utf8');
  const valid = (c) => /^-?[A-Za-z_][\w-]*$/.test(c);
  for (const c of [...(body.addClasses || []), ...(body.removeClasses || []), ...(body.id ? [body.id] : [])]) {
    if (!valid(c)) throw new HttpError(400, `Invalid class or id: ${c}`);
  }
  let result;
  let next;
  try {
    next = editBlockAttrs(text, { line: Number(body.line), end: Number(body.end), kind: body.kind }, (a) => {
      const remove = new Set(body.removeClasses || []);
      a.classes = a.classes.filter((c) => !remove.has(c));
      a.classes.push(...(body.addClasses || []));
      if (body.id !== undefined) a.id = body.id || null;
      result = a;
    });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  if (next !== text) await fs.writeFile(full, next);
  return { id: result.id, classes: [...new Set(result.classes)] };
}

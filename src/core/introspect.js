// What a Blend offers: classes its CSS styles, design tokens, presets, variables, templates.
// Used by `docubrew check` (is this class styled?) and `docubrew context` (what can an AI use?).
import fs from 'node:fs/promises';
import path from 'node:path';
import { readBlendManifest, LAYERS, FONTS_FILE } from './blend.js';
import { listFiles } from './util.js';

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return ''; }
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Class names used in selectors (not in url() or strings). */
export function classesInCss(css) {
  const out = new Set();
  const clean = stripComments(css).replace(/url\([^)]*\)/g, '').replace(/"[^"]*"|'[^']*'/g, '""');
  // selectors are the text before each "{"
  for (const m of clean.matchAll(/([^{}]+)\{/g)) {
    if (m[1].trim().startsWith('@')) continue;
    for (const c of m[1].matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(c[1]);
  }
  return out;
}

/** Custom properties declared in a stylesheet: { "--accent": "#e2231a", … } */
export function customProperties(css) {
  const out = {};
  for (const m of stripComments(css).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) out[m[1]] = m[2].trim();
  return out;
}

/** Variables referenced by templates: {{ machine.model }}, {{#if author}}, {{#each revisions}} */
function templateVariables(html) {
  const out = new Set();
  for (const m of html.matchAll(/{{{?\s*(?:#(?:if|each)\s+)?([\w.@-]+)\s*}?}}/g)) {
    const v = m[1];
    if (['else', 'this', '@index'].includes(v) || v.startsWith('this.') || v.startsWith('chapter.') || v.startsWith('toc.')) continue;
    out.add(v);
  }
  return [...out].sort();
}

/**
 * Summarize a Blend folder (a Brew's blend/ copy, or a flattened Library Blend).
 * Also accepts extra CSS (e.g. a Brew's overrides.css) whose classes count as available.
 */
export async function blendSummary(blendDir, { extraCss = '' } = {}) {
  let manifest = {};
  try { manifest = await readBlendManifest(blendDir); } catch {}
  const layers = {};
  const classes = new Set();
  for (const layer of LAYERS) {
    const css = await readText(path.join(blendDir, `${layer}.css`));
    layers[layer] = css;
    for (const c of classesInCss(css)) classes.add(c);
  }
  for (const c of classesInCss(extraCss)) classes.add(c);
  const templates = {};
  for (const rel of (await listFiles(path.join(blendDir, 'templates'))).filter((f) => f.endsWith('.html'))) {
    const html = await readText(path.join(blendDir, 'templates', rel));
    templates[rel] = templateVariables(html);
    // classes in templates are styled by the Blend too, but they're not for authors to use
  }
  const fonts = [...new Set([...(await readText(path.join(blendDir, FONTS_FILE))).matchAll(/font-family:\s*"([^"]+)"/g)].map((m) => m[1]))];
  return {
    name: manifest.name || path.basename(blendDir),
    version: manifest.version || null,
    description: manifest.description || '',
    extends: manifest.flattenedFrom || (manifest.extends ? [manifest.extends] : []),
    page: manifest.page || {},
    toc: manifest.toc ?? null,
    markdown: manifest.markdown || {},
    variables: manifest.variables || {},
    presets: manifest.presets || {},
    tokens: customProperties(layers.tokens),
    classes: [...classes].sort(),
    templates,
    fonts,
  };
}

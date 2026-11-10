// Brew → HTML document ready for Paged.js.
//
// The same HTML is used for the on-screen preview and for PDF export, so what you see is what prints.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import MarkdownIt from 'markdown-it';
import markdownItAttrs from 'markdown-it-attrs';
import markdownItContainer from 'markdown-it-container';
import markdownItFootnote from 'markdown-it-footnote';
import { loadBrew, BLEND_DIR, OVERRIDES_FILE } from './brew.js';
import { LAYERS, LAYER_ORDER, FONTS_FILE } from './blend.js';
import { renderTemplate } from './template.js';
import { escapeHtml, exists, getPath, splitFrontMatter } from './util.js';

const CALLOUTS = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
  danger: 'Danger',
};

// ─── Markdown ────────────────────────────────────────────────────────────────

export function createMarkdown() {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

  md.use(markdownItAttrs, { allowedAttributes: ['id', 'class', 'style', 'width', 'height', /^data-.*$/] });
  md.use(markdownItFootnote);

  // ::: warning Optional title     → <aside class="callout callout-warning">
  // ::: steps                       → <div class="steps">
  md.use(markdownItContainer, 'block', {
    validate: (params) => /^[a-z][\w-]*/i.test(params.trim()),
    render(tokens, idx) {
      const tok = tokens[idx];
      if (tok.nesting === -1) return tok.info === 'callout' ? '</aside>\n' : '</div>\n';
      const m = /^([a-z][\w-]*)\s*(.*)$/i.exec(tok.info.trim());
      const type = m[1].toLowerCase();
      const title = m[2];
      const line = tok.map ? ` data-source-line="${tok.map[0] + 1 + (tok.meta?.offset || 0)}"` : '';
      if (CALLOUTS[type]) {
        // remember the kind so the closing token renders </aside>
        const close = findContainerClose(tokens, idx);
        if (close) close.info = 'callout';
        return `<aside class="callout callout-${type}"${line}>\n<p class="callout-title">${md.renderInline(title || CALLOUTS[type])}</p>\n`;
      }
      const titleHtml = title ? `<p class="block-title">${md.renderInline(title)}</p>\n` : '';
      return `<div class="${escapeHtml(type)}"${line}>\n${titleHtml}`;
    },
  });

  md.core.ruler.push('docubrew_figures', figureRule(md));
  md.core.ruler.push('docubrew_source_lines', sourceLineRule);

  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const tok = tokens[idx];
    const src = tok.attrGet('src');
    if (env?.resolveAsset && src) tok.attrSet('src', env.resolveAsset(src));
    return defaultImage(tokens, idx, options, env, self);
  };

  return md;
}

function findContainerClose(tokens, idx) {
  let depth = 0;
  for (let i = idx; i < tokens.length; i++) {
    if (tokens[i].type === 'container_block_open') depth++;
    if (tokens[i].type === 'container_block_close' && --depth === 0) return tokens[i];
  }
  return null;
}

// Tag block elements with the Markdown line they came from (for scroll sync, drop-to-insert, inspector).
function sourceLineRule(state) {
  const offset = state.env?.lineOffset || 0;
  for (const tok of state.tokens) {
    if (tok.type === 'container_block_open') tok.meta = { ...(tok.meta || {}), offset };
    if (!tok.map || tok.nesting === -1 || !tok.block) continue;
    if (tok.type === 'inline' || tok.type.startsWith('container_')) continue;
    tok.attrSet('data-source-line', String(tok.map[0] + 1 + offset));
  }
}

// A paragraph that holds only an image becomes <figure>, with the image title as <figcaption>.
// Classes/id/style written after the image ({.fig-right}) move to the figure.
function figureRule(md) {
  return (state) => {
    const t = state.tokens;
    for (let i = 0; i < t.length - 2; i++) {
      if (t[i].type !== 'paragraph_open' || t[i + 1].type !== 'inline' || t[i + 2].type !== 'paragraph_close') continue;
      const kids = t[i + 1].children.filter((c) => !(c.type === 'text' && !c.content.trim()) && c.type !== 'softbreak');
      if (kids.length !== 1 || kids[0].type !== 'image') continue;
      const img = kids[0];
      t[i].tag = t[i + 2].tag = 'figure';
      for (const name of ['class', 'id', 'style']) {
        const v = img.attrGet(name);
        if (v != null) {
          t[i].attrSet(name, v);
          img.attrs = img.attrs.filter(([k]) => k !== name);
        }
      }
      const title = img.attrGet('title');
      if (title) {
        const cap = new state.Token('html_inline', '', 0);
        cap.content = `<figcaption>${md.renderInline(title)}</figcaption>`;
        t[i + 1].children = [img, cap];
      } else {
        t[i + 1].children = [img];
      }
    }
  };
}

// {{ variable.path }} in Markdown. \{{ escapes. Unknown variables are left visible so typos are noticed.
export function substituteVariables(text, vars) {
  return text.replace(/(\\?){{\s*([\w.@-]+)\s*}}/g, (whole, esc, key) => {
    if (esc) return whole.slice(1);
    const v = getPath(vars, key);
    if (v === undefined || v === null || typeof v === 'object') return whole;
    return escapeHtml(v);
  });
}

// ─── CSS setup ───────────────────────────────────────────────────────────────

const PAGE_SIZES = { letter: 'letter', a4: 'A4', a5: 'A5', legal: 'legal', 'half-letter': '5.5in 8.5in', 'b5': 'B5' };

function pageRule(page) {
  const decls = [];
  if (page.size) {
    const [name, ...rest] = String(page.size).trim().split(/\s+/);
    const size = PAGE_SIZES[name.toLowerCase()] ? [PAGE_SIZES[name.toLowerCase()], ...rest].join(' ') : page.size;
    decls.push(`size: ${size};`);
  }
  if (page.margin) decls.push(`margin: ${page.margin};`);
  if (page.bleed) decls.push(`bleed: ${page.bleed};`);
  if (page.marks) decls.push(`marks: ${page.marks};`);
  return decls.length ? `@page { ${decls.join(' ')} }` : '';
}

function setupCss({ blendPage, brewPage }) {
  return `@layer docubrew, ${LAYER_ORDER.join(', ')};
@layer docubrew {
  .db-running { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .db-doc-title { string-set: doc-title content(text); }
  .page-break { break-after: page; }
}
@layer page { ${pageRule(blendPage)} }
@layer document { ${pageRule(brewPage)} }`;
}

// ─── Document ────────────────────────────────────────────────────────────────

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

/**
 * Render a Brew folder to a complete HTML document.
 * @param {string} dir  Brew folder
 * @param {object} opts { mode: 'preview'|'print', runtimeSrc, pagedSrc, cacheBust }
 */
export async function renderBrew(dir, opts = {}) {
  const { mode = 'preview', runtimeSrc = '/app/preview-runtime.js', pagedSrc = '/vendor/paged.polyfill.js', cacheBust = Date.now() } = opts;
  const brew = await loadBrew(dir);
  const md = createMarkdown();
  const blendDir = path.join(dir, BLEND_DIR);

  const resolveAsset = (src) => {
    if (/^([a-z]+:|\/|#)/i.test(src)) return src;
    const clean = decodeURI(src.split(/[?#]/)[0]);
    // Paths may be written relative to content/ (as editors like VS Code expect) or to the Brew root.
    const fromContent = path.posix.normalize(path.posix.join('content', clean));
    if (!fromContent.startsWith('..') && existsSync(path.join(dir, fromContent))) return fromContent;
    return src;
  };

  // Chapters
  const chapterTpl = await readOptional(path.join(blendDir, 'templates', 'chapter-opener.html'));
  const chapters = [];
  for (const [i, rel] of brew.chapters.entries()) {
    const raw = await fs.readFile(path.join(dir, rel), 'utf8');
    let front;
    try {
      front = splitFrontMatter(raw, YAML.parse);
    } catch (err) {
      throw new Error(`Front matter in ${rel}: ${err.message}`);
    }
    const chapter = { number: i + 1, ...front.data, file: rel, index: i };
    chapter.numberPadded = String(chapter.number).padStart(2, '0');
    const ctx = { ...brew.vars, chapter };
    const body = md.render(substituteVariables(front.body, ctx), { lineOffset: front.offset, resolveAsset, docId: `c${i + 1}` });
    const wantsOpener = chapter.title && chapter.template !== 'none' && chapterTpl;
    const opener = wantsOpener ? renderTemplate(chapterTpl, ctx) : '';
    const classes = ['chapter', chapter.class].filter(Boolean).join(' ');
    chapters.push({
      open: `<section class="${escapeHtml(classes)}" id="chapter-${i + 1}" data-source-file="${escapeHtml(rel)}"${wantsOpener ? ' data-opener' : ''}>`,
      body: `${opener}\n${body}`,
    });
  }

  // Title page
  let titlePage = '';
  if (brew.manifest.titlePage !== false) {
    const tpl = await readOptional(path.join(blendDir, 'templates', 'title-page.html'));
    if (tpl) titlePage = { open: '<section class="title-page" data-source-file="brew.yaml">', body: renderTemplate(tpl, brew.vars) };
  }
  const sections = [titlePage, ...chapters].filter(Boolean);

  // Running values: an optional template whose elements feed string-set (page headers/footers).
  const runningTpl = await readOptional(path.join(blendDir, 'templates', 'running.html'));
  const running = runningTpl ? renderTemplate(runningTpl, brew.vars) : '';

  // Stylesheets, in cascade order
  const v = `v=${cacheBust}`;
  const links = [];
  if (await exists(path.join(blendDir, FONTS_FILE))) links.push(`${BLEND_DIR}/${FONTS_FILE}?${v}`);
  for (const layer of LAYERS) {
    if (await exists(path.join(blendDir, `${layer}.css`))) links.push(`${BLEND_DIR}/${layer}.css?layer=${layer}&${v}`);
  }
  if (await exists(path.join(dir, OVERRIDES_FILE))) links.push(`${OVERRIDES_FILE}?layer=document&${v}`);

  const lang = brew.manifest.lang || 'en';
  const html = `<!doctype html>
<html lang="${escapeHtml(lang)}" data-mode="${mode}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(brew.vars.title)}</title>
<style data-docubrew="setup">
${setupCss({ blendPage: brew.blend?.page || {}, brewPage: brew.manifest.page || {} })}
</style>
${links.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
<script src="${runtimeSrc}"></script>
<script src="${pagedSrc}"></script>
</head>
<body>
${sections
  .map((s, i) => {
    // Running values go inside the first section so they never create a page of their own.
    const runningHtml = i === 0 ? `<div class="db-running" aria-hidden="true"><span class="db-doc-title">${escapeHtml(brew.vars.title)}</span>${running}</div>\n` : '';
    return `${s.open}\n${runningHtml}${s.body}\n</section>`;
  })
  .join('\n')}
</body>
</html>`;

  return { html, brew };
}

/** Wrap a Blend/overrides stylesheet in its cascade layer. */
export function wrapLayer(css, layer) {
  if (!LAYER_ORDER.includes(layer)) return css;
  return `@layer ${layer} {\n${css}\n}\n`;
}

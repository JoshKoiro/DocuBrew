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
import { loadBrew, expandText, BLEND_DIR, OVERRIDES_FILE } from './brew.js';
import { LAYERS, LAYER_ORDER, FONTS_FILE } from './blend.js';
import { renderTemplate } from './template.js';
import { escapeHtml, exists, getPath, splitFrontMatter, deepMerge } from './util.js';

const CALLOUTS = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
  danger: 'Danger',
};

// ─── Markdown ────────────────────────────────────────────────────────────────

export function createMarkdown({ script = false, leadIn = 0 } = {}) {
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
      const off = tok.meta?.offset || 0;
      const line = tok.map ? ` data-source-line="${tok.map[0] + 1 + off}" data-source-end="${tok.map[1] + off}"` : '';
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
  if (script) md.core.ruler.push('docubrew_script', scriptRule(md));
  md.core.ruler.push('docubrew_chapter_first', chapterFirstRule(Number(leadIn) || 0));
  md.core.ruler.push('docubrew_heading_ids', headingIdRule);
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
    tok.attrSet('data-source-end', String(tok.map[1] + offset)); // last line of the block, 1-based
  }
}

// Script markup (plays, screenplays), switched on by a Blend with `markdown: { script: true }`.
// Follows the Fountain convention:
//   HAMLET                     a paragraph whose first line is a name in capitals → dialogue
//   (aside)                    a line in parentheses inside dialogue → parenthetical
//   To be, or not to be.
//
//   (He draws his dagger.)     a paragraph entirely in parentheses → stage direction
const CUE = /^([A-Z][A-Z0-9 .'’&-]*[A-Z0-9.'’])(\s*\([^)]*\))?$/;
function scriptRule(md) {
  return (state) => {
    const t = state.tokens;
    for (let i = 0; i < t.length - 2; i++) {
      if (t[i].type !== 'paragraph_open' || t[i + 1].type !== 'inline' || t[i + 2].type !== 'paragraph_close') continue;
      const text = t[i + 1].content.trim();
      if (/^\([\s\S]*\)$/.test(text)) {
        t[i].attrJoin('class', 'stage-direction');
        continue;
      }
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const m = CUE.exec(lines[0]);
      if (!m || lines.length < 2 || (m[1].match(/[A-Z]/g) || []).length < 2) continue;
      const env = state.env;
      const off = env?.lineOffset || 0;
      const lineAttrs = t[i].map ? { 'data-source-line': t[i].map[0] + 1 + off, 'data-source-end': t[i].map[1] + off } : {};
      const attrs = [...(t[i].attrs || []), ...Object.entries(lineAttrs)].map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
      let html = `<div class="dialogue"${attrs}>\n<p class="character">${escapeHtml(m[1])}${m[2] ? ` <span class="extension">${escapeHtml(m[2].trim())}</span>` : ''}</p>\n`;
      let speech = [];
      const flush = () => {
        if (speech.length) html += `<p class="line">${md.renderInline(speech.join('\n'), env)}</p>\n`;
        speech = [];
      };
      for (const line of lines.slice(1)) {
        if (/^\(.*\)$/.test(line)) { flush(); html += `<p class="parenthetical">${md.renderInline(line, env)}</p>\n`; }
        else speech.push(line);
      }
      flush();
      html += '</div>\n';
      const block = new state.Token('html_block', '', 0);
      block.content = html;
      block.map = t[i].map;
      t.splice(i, 3, block);
    }
  };
}

// Mark each chapter's first top-level paragraph with class "chapter-first" and, if the Blend asks
// (`markdown: { leadIn: 4 }`), wrap its first words in <span class="lead-in"> — the book convention of
// setting the opening words in small capitals. (Paged.js drops ::first-line rules, so CSS can't do it.)
function chapterFirstRule(leadIn) {
  return (state) => {
    const t = state.tokens;
    const i = t.findIndex((tok) => tok.type === 'paragraph_open' && tok.level === 0 && !tok.attrGet('class')?.includes('stage-direction'));
    if (i < 0 || t[i].tag !== 'p') return;
    t[i].attrJoin('class', 'chapter-first');
    if (!leadIn) return;
    const kids = t[i + 1].children || [];
    const first = kids.findIndex((k) => k.type === 'text' && k.content.trim());
    if (first !== 0) return; // starts with emphasis, a link or an image: leave it alone
    const m = new RegExp(`^(\\s*(?:\\S+\\s+){0,${leadIn - 1}}\\S+)([\\s\\S]*)$`).exec(kids[0].content);
    if (!m) return;
    const open = new state.Token('html_inline', '', 0); open.content = '<span class="lead-in">';
    const words = new state.Token('text', '', 0); words.content = m[1];
    const close = new state.Token('html_inline', '', 0); close.content = '</span>';
    const rest = new state.Token('text', '', 0); rest.content = m[2];
    kids.splice(0, 1, open, words, close, rest);
  };
}

// Give every heading an id (for the table of contents and links) and collect it in env.headings.
// Ids written by the author ({#my-id}) are kept.
function headingIdRule(state) {
  const env = state.env || {};
  const used = env.usedIds || new Set();
  const t = state.tokens;
  for (let i = 0; i < t.length; i++) {
    if (t[i].type !== 'heading_open') continue;
    const inline = t[i + 1];
    const text = (inline.children || []).filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('').trim();
    let id = t[i].attrGet('id');
    if (!id) {
      const base = `${env.docId ? `${env.docId}-` : ''}${slugifyId(text) || 'section'}`;
      id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      t[i].attrSet('id', id);
    }
    used.add(id);
    env.headings?.push({ level: Number(t[i].tag.slice(1)), text, id });
  }
}

function slugifyId(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
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
        if (v == null) continue;
        const existing = t[i].attrGet(name);
        // classes/styles from "![..](..){.x}" and "![..](..) {.y}" combine; an id on the figure wins
        if (existing == null) t[i].attrSet(name, v);
        else if (name === 'class') t[i].attrSet(name, `${existing} ${v}`);
        else if (name === 'style') t[i].attrSet(name, `${existing.replace(/;?\s*$/, ';')} ${v}`);
        img.attrs = img.attrs.filter(([k]) => k !== name);
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

// Used when the Blend has no templates/toc.html. Page numbers come from CSS:
//   .toc-page a::after { content: target-counter(attr(href), page); }
const DEFAULT_TOC = `<nav class="toc">
  <h1 class="toc-title">{{ toc.title }}</h1>
  <ol class="toc-list">
    {{#each toc.entries}}<li class="toc-entry {{ this.levelClass }}"><a href="{{ this.href }}">{{#if this.number}}<span class="toc-number">{{ this.number }}</span>{{/if}}<span class="toc-text">{{ this.text }}</span></a></li>
    {{/each}}
  </ol>
</nav>`;

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
  // The Blend Editor renders a Brew's content with a live Library Blend instead of the Brew's copy.
  const blendDir = opts.blendDir || path.join(dir, BLEND_DIR);
  const brew = await loadBrew(dir, { blendDir });
  const mdOptions = { ...(brew.blend?.markdown || {}), ...(brew.manifest.markdown || {}) };
  // Variable overrides (CLI --set / --data): merged over brew.yaml's variables.
  if (opts.vars && Object.keys(opts.vars).length) {
    brew.vars = deepMerge(brew.vars, opts.vars);
    for (const k of ['title', 'subtitle', 'author', 'revision', 'date']) if (k in opts.vars) brew.vars.doc[k] = opts.vars[k];
  }
  // Titles may use variables: "Care Record — {{ machine.model }}"
  for (const k of ['title', 'subtitle']) {
    brew.vars[k] = expandText(brew.vars[k], brew.vars);
    brew.vars.doc[k] = expandText(brew.vars.doc[k], brew.vars);
  }
  const md = createMarkdown({ script: Boolean(mdOptions.script), leadIn: mdOptions.leadIn });
  const usedIds = new Set();
  const tocEntries = [];

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
    const headings = [];
    const body = md.render(substituteVariables(front.body, ctx), { lineOffset: front.offset, resolveAsset, docId: `c${i + 1}`, usedIds, headings });
    const wantsOpener = chapter.title && chapter.template !== 'none' && chapterTpl;
    if (chapter.title && chapter.toc !== false) {
      tocEntries.push({ level: 1, text: chapter.title, href: `#chapter-${i + 1}`, number: chapter.numberPadded });
    }
    if (chapter.toc !== false) {
      for (const h of headings) {
        // With an opener, the chapter title is level 1 and ## is level 2. Without one, # is level 1.
        const level = chapter.title ? Math.max(2, h.level) : h.level;
        tocEntries.push({ level, text: h.text, href: `#${h.id}`, number: '' });
      }
    }
    const opener = wantsOpener ? renderTemplate(chapterTpl, ctx) : '';
    const classes = ['chapter', chapter.class].filter(Boolean).join(' ');
    chapters.push({
      open: `<section class="${escapeHtml(classes)}" id="chapter-${i + 1}" data-source-file="${escapeHtml(rel)}" data-body-line="${front.offset + 1}"${wantsOpener ? ' data-opener' : ''}>`,
      body: `${opener}\n${body}`,
    });
  }

  // Title page
  let titlePage = '';
  if (brew.manifest.titlePage !== false) {
    const tpl = await readOptional(path.join(blendDir, 'templates', 'title-page.html'));
    if (tpl) titlePage = { open: '<section class="title-page" data-source-file="brew.yaml">', body: renderTemplate(tpl, brew.vars) };
  }
  // Table of contents: `toc: true` or `toc: { depth: 2, title: Contents }` in brew.yaml (or blend.yaml)
  let tocSection = null;
  const tocOpt = brew.manifest.toc ?? brew.blend?.toc ?? false;
  if (tocOpt) {
    const depth = Number(tocOpt.depth) || 2;
    const entries = tocEntries.filter((e) => e.level <= depth).map((e) => ({ ...e, levelClass: `toc-level-${e.level}` }));
    const tpl = (await readOptional(path.join(blendDir, 'templates', 'toc.html'))) || DEFAULT_TOC;
    tocSection = {
      open: '<section class="toc-page" data-source-file="brew.yaml">',
      body: renderTemplate(tpl, { ...brew.vars, toc: { title: tocOpt.title || 'Contents', entries } }),
    };
  }
  const sections = [titlePage, tocSection, ...chapters].filter(Boolean);

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

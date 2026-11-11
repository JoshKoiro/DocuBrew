// `docubrew check`: validate a Brew the way an editor (or an AI) needs — file and line for every problem.
//
// Static checks read the files; the optional render check (see preview-runtime's __docubrewOverflow)
// finds content wider or taller than the page in a real Paged.js render.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadBrew, readBrewManifest, BREW_FILE, BLEND_DIR, OVERRIDES_FILE } from './brew.js';
import { renderBrew } from './render.js';
import { blendSummary } from './introspect.js';
import { blendStatus } from './blend-status.js';
import { splitFrontMatter, getPath } from './util.js';

const CALLOUTS = new Set(['note', 'tip', 'important', 'warning', 'caution', 'danger']);
// Classes DocuBrew itself produces; never "unstyled" from the author's point of view.
const BUILT_IN = new Set(['page-break']);

function problem(severity, file, line, message, hint) {
  return { severity, file, line: line || null, message, ...(hint ? { hint } : {}) };
}

function yamlLine(err) {
  return err?.linePos?.[0]?.line || null;
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

/** Unbalanced braces in a stylesheet (ignoring comments and strings). Returns the line of the first problem. */
function braceProblem(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/"[^"\n]*"|'[^'\n]*'/g, (m) => ' '.repeat(m.length));
  let depth = 0;
  let line = 1;
  let openLine = 1;
  for (const ch of clean) {
    if (ch === '\n') line++;
    else if (ch === '{') { if (depth === 0) openLine = line; depth++; }
    else if (ch === '}') { depth--; if (depth < 0) return { line, message: 'Unexpected "}" — a rule closes that never opened.' }; }
  }
  return depth > 0 ? { line: openLine, message: 'A rule is never closed — missing "}".' } : null;
}

/**
 * @param {string} dir  Brew folder
 * @param {object} opts { libraryDir }  (to compare the Blend copy with the Library)
 * @returns {{ problems, chapters, ok }}
 */
export async function checkBrew(dir, { libraryDir } = {}) {
  const problems = [];
  const add = (...a) => problems.push(problem(...a));

  // brew.yaml
  let manifest;
  try {
    manifest = await readBrewManifest(dir);
  } catch (err) {
    add('error', BREW_FILE, yamlLine(err.cause || err), err.message.replace(/^Could not read brew\.yaml: /, 'brew.yaml: '));
    return { problems, ok: false };
  }
  if (!manifest.title) add('warning', BREW_FILE, 1, 'No title.', 'Add "title: …" — it names the PDF and the running headers.');
  if (!existsSync(path.join(dir, BLEND_DIR, 'blend.yaml'))) add('error', BLEND_DIR, null, 'This Brew has no Blend copy, so it has no styles.', 'Create Brews with "docubrew new" or the app, or run "docubrew blend update".');

  if (libraryDir) {
    try {
      const s = await blendStatus(libraryDir, dir);
      if (s.state === 'out-of-date') add('info', BREW_FILE, null, `The Library has a newer ${s.name}${s.libraryVersion ? ` (${s.libraryVersion})` : ''}.`, 'Run "docubrew blend update" or use Update in the app.');
      if (s.state === 'missing') add('info', BREW_FILE, null, `The Blend "${s.source}" isn't in the Library. The Brew still renders from its own copy.`);
      if (s.locallyModified) add('warning', BLEND_DIR, null, 'The Blend copy was edited by hand. Edits there are replaced on update.', 'Move them to overrides.css.');
    } catch {}
  }

  // overrides.css
  const overrides = (await readText(path.join(dir, OVERRIDES_FILE))) || '';
  const bp = braceProblem(overrides);
  if (bp) add('error', OVERRIDES_FILE, bp.line, bp.message);

  // What the Blend + overrides style
  const summary = await blendSummary(path.join(dir, BLEND_DIR), { extraCss: overrides });
  const styled = new Set([...summary.classes, ...BUILT_IN]);

  let brew;
  try {
    brew = await loadBrew(dir);
  } catch (err) {
    add('error', BREW_FILE, null, err.message);
    return { problems, ok: false };
  }
  if (!brew.chapters.length) add('warning', 'content', null, 'No chapters yet.', 'Add Markdown files to content/, e.g. content/01-introduction.md.');

  const links = [];        // { file, line, id }
  const ids = new Map();   // id → first "file:line"
  const chapters = [];

  for (const [index, rel] of brew.chapters.entries()) {
    const raw = await fs.readFile(path.join(dir, rel), 'utf8');
    const name = path.basename(rel);
    if (!/^\d+[-_ ]/.test(name)) add('info', rel, null, 'Chapter files are rendered in filename order; a number prefix (01-…) makes the order explicit.');

    let front;
    try {
      front = splitFrontMatter(raw, YAML.parse);
    } catch (err) {
      add('error', rel, (yamlLine(err) || 0) + 1, `Front matter: ${err.message.split('\n')[0]}`);
      continue;
    }
    const chapter = { number: index + 1, numberPadded: String(index + 1).padStart(2, '0'), ...front.data };
    const ctx = { ...brew.vars, chapter };
    chapters.push({ file: rel, title: front.data.title || null });

    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    let inFence = false;
    let lastHeading = 0;
    const containers = [];
    for (let i = front.offset; i < lines.length; i++) {
      const line = lines[i];
      const n = i + 1;
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const text = line.replace(/`[^`]*`/g, ''); // ignore inline code

      // Variables
      for (const m of text.matchAll(/(\\?){{\s*([\w.@-]+)\s*}}/g)) {
        if (m[1]) continue;
        const v = getPath(ctx, m[2]);
        if (v === undefined || v === null) add('warning', rel, n, `Unknown variable {{ ${m[2]} }} — it will print as-is.`, 'Define it under "variables:" in brew.yaml, or write \\{{ to show braces.');
        else if (typeof v === 'object') add('warning', rel, n, `{{ ${m[2]} }} is a list or group, not a single value.`);
      }

      // Images
      for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img[^>]+src=["']([^"']+)["']/g)) {
        const src = decodeURI((m[1] || m[2]).split(/[?#]/)[0]);
        if (/^([a-z]+:|\/)/i.test(src)) continue;
        const fromContent = path.join(dir, 'content', src);
        const fromRoot = path.join(dir, src);
        if (!existsSync(fromContent) && !existsSync(fromRoot)) add('error', rel, n, `Image not found: ${src}`, 'Put images in images/ and link them as ../images/name.png.');
      }

      // Links to ids
      for (const m of text.matchAll(/\]\(#([^)\s]+)\)|href=["']#([^"']+)["']/g)) links.push({ file: rel, line: n, id: decodeURIComponent(m[1] || m[2]) });

      // Attributes {#id .class}
      const attr = /{([^{}]*)}\s*$/.exec(text);
      if (attr && /^\s*[#.]/.test(attr[1]) && !/}}\s*$/.test(text)) {
        for (const tok of attr[1].trim().split(/\s+/)) {
          if (tok.startsWith('.') && !styled.has(tok.slice(1))) add('warning', rel, n, `Class .${tok.slice(1)} isn't styled by the Blend or overrides.css.`, summary.presets ? `Presets: ${Object.values(summary.presets).flat().map((p) => `.${p.class}`).join(' ') || 'none'}` : undefined);
          if (tok.startsWith('#')) {
            const id = tok.slice(1);
            if (ids.has(id)) add('warning', rel, n, `Duplicate id #${id} (also at ${ids.get(id)}).`);
            else ids.set(id, `${rel}:${n}`);
          }
        }
        // Attributes directly under a table become an extra row
        if (/^\s*{[^{}]*}\s*$/.test(line) && /^\s*\|/.test(lines[i - 1] || '')) add('error', rel, n, 'Attributes directly under a table are read as a table row.', 'Leave a blank line between the table and {…}.');
      }

      // Containers ::: name
      const open = /^\s*:::\s*([A-Za-z][\w-]*)/.exec(line);
      if (open) {
        const type = open[1].toLowerCase();
        containers.push(n);
        if (!CALLOUTS.has(type) && !styled.has(type)) add('warning', rel, n, `::: ${type} has no style in this Blend — it renders as a plain block.`, 'Callouts: note, tip, important, warning, caution, danger.');
      } else if (/^\s*:::\s*$/.test(line)) {
        if (!containers.pop()) add('warning', rel, n, 'Closing ::: without an opening one.');
      }

      // Heading levels
      const h = /^(#{1,6})\s/.exec(line);
      if (h) {
        const level = h[1].length;
        if (lastHeading && level > lastHeading + 1) add('info', rel, n, `Heading jumps from level ${lastHeading} to ${level}.`);
        lastHeading = level;
      }
    }
    for (const n of containers) add('warning', rel, n, '::: block is never closed — everything after it is inside it.');
    if (inFence) add('warning', rel, null, 'A ``` code block is never closed.');
    if (!lines.slice(front.offset).some((l) => l.trim())) add('info', rel, null, 'Chapter is empty.');
  }

  // Render (without a browser) to check links against the real ids, and catch template errors
  try {
    const { html } = await renderBrew(dir);
    const rendered = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const l of links) if (!rendered.has(l.id)) add('warning', l.file, l.line, `Link to #${l.id} goes nowhere.`, 'Chapters are #chapter-1, #chapter-2 …; headings get ids from their text.');
  } catch (err) {
    add('error', BREW_FILE, null, `Render failed: ${err.message}`);
  }

  const order = { error: 0, warning: 1, info: 2 };
  problems.sort((a, b) => order[a.severity] - order[b.severity] || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
  return { problems, chapters, ok: !problems.some((p) => p.severity === 'error') };
}

/** Turn the browser's overflow report into problems. */
export function overflowProblems(report = []) {
  return report.map((o) => problem('warning', o.file || 'content', o.line ? Number(o.line) : null,
    o.kind === 'tall'
      ? `${o.what} is taller than the page (page ${o.page}) and gets cut off.`
      : `${o.what} runs ${o.by} px past the page margin (page ${o.page}).`,
    o.what === 'Table' || o.what === 'Code block' ? 'Shorten the content, reduce the font size, or set a width in overrides.css.' : 'Give it a smaller width, e.g. {.fig-half}.'));
}

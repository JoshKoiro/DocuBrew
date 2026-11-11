// AI context: everything an assistant needs to write for one Brew, as Markdown to paste into a chat
// (or for `docubrew context`). Also keeps the workspace's AGENTS.md / CLAUDE.md guide current.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadBrew, expandText, BREW_FILE, BLEND_DIR, OVERRIDES_FILE } from './brew.js';
import { blendSummary } from './introspect.js';
import { checkBrew } from './check.js';
import { APP_ROOT } from './workspace.js';
import { sha256, exists } from './util.js';

const GUIDE_SOURCE = path.join(APP_ROOT, 'docs', 'AI-GUIDE.md');
// Classes that belong to a Blend's own templates, not for authors to use in Markdown.
const TEMPLATE_CLASS = /^(tp|co|toc|run|care|bk|play|act|tw|footnote|footnotes|chapter|title-page|db|memo-line)(-|$)/;

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return ''; }
}

export async function aiGuide() {
  return readText(GUIDE_SOURCE);
}

const fence = (lang, text) => `\`\`\`${lang}\n${text.replace(/\s+$/, '')}\n\`\`\``;

/**
 * @param {string} dir  Brew folder
 * @param {object} opts { libraryDir, content = true, guide = true, check = true }
 */
export async function buildContext(dir, { libraryDir, content = true, guide = true, check = true } = {}) {
  const brew = await loadBrew(dir);
  const overrides = await readText(path.join(dir, OVERRIDES_FILE));
  const s = await blendSummary(path.join(dir, BLEND_DIR));
  const out = [];

  out.push(`# DocuBrew context — ${expandText(brew.vars.title, brew.vars)}`);
  out.push(`Brew folder: \`${path.basename(dir)}/\` · Blend: **${s.name}** ${s.version || ''}${s.extends.length > 1 ? ` (built on ${s.extends.slice(0, -1).join(', ')})` : ''}`);
  out.push('Use this to write or edit this document. Files are relative to the Brew folder. Follow the guide at the end.');

  out.push('## brew.yaml', fence('yaml', await readText(path.join(dir, BREW_FILE))));

  const chapterLines = [];
  for (const rel of brew.chapters) {
    const text = await readText(path.join(dir, rel));
    const title = /^---[\s\S]*?^title:\s*(.+)$/m.exec(text)?.[1]?.trim();
    chapterLines.push(`- \`${rel}\`${title ? ` — ${title}` : ''}`);
  }
  out.push('## Chapters', chapterLines.join('\n') || '_None yet._');

  // What the Blend offers
  out.push(`## The Blend: ${s.name}`);
  if (s.description) out.push(s.description);
  const page = [s.page.size && `size ${s.page.size}`, s.page.margin && `margins ${s.page.margin}`].filter(Boolean).join(', ');
  if (page) out.push(`Page: ${page}.`);
  if (s.markdown.script) out.push('**Script markup is on** (stage play): NAME IN CAPITALS paragraphs are dialogue, (parenthesised) paragraphs are stage directions.');
  if (s.markdown.leadIn) out.push(`A chapter's first ${s.markdown.leadIn} words are set as a lead-in.`);

  const presets = Object.entries(s.presets);
  if (presets.length) {
    out.push('### Presets (prefer these)', presets.map(([kind, list]) => `- ${kind}: ${list.map((p) => `\`.${p.class}\` (${p.label || p.class})`).join(', ')}`).join('\n'));
  }
  const authorClasses = s.classes.filter((c) => !TEMPLATE_CLASS.test(c));
  out.push('### Classes this Blend styles', authorClasses.map((c) => `\`.${c}\``).join(' ') || '_none_');
  out.push('Callouts: `::: note|tip|important|warning|caution|danger`. Other `::: name` blocks need a matching class above.');

  if (Object.keys(s.variables).length) out.push('### Variables (Blend defaults — set them in brew.yaml)', fence('yaml', YAML.stringify(s.variables)));
  const tplVars = Object.entries(s.templates).filter(([, v]) => v.length);
  if (tplVars.length) out.push('### Template fields', tplVars.map(([t, v]) => `- \`${t}\`: ${v.map((x) => `\`${x}\``).join(', ')}`).join('\n'));
  if (Object.keys(s.tokens).length) {
    out.push('### Design tokens (override in overrides.css with `:root { … }`)');
    out.push(fence('css', `:root {\n${Object.entries(s.tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`));
  }

  if (overrides.replace(/\/\*[\s\S]*?\*\//g, '').trim()) out.push('## overrides.css', fence('css', overrides));

  if (check) {
    const r = await checkBrew(dir, { libraryDir });
    out.push('## Current check results');
    out.push(r.problems.length ? r.problems.map((p) => `- **${p.severity}** \`${p.file}${p.line ? `:${p.line}` : ''}\` ${p.message}`).join('\n') : 'No problems found.');
  }

  if (content) {
    out.push('## Chapter files');
    for (const rel of brew.chapters) out.push(`### ${rel}`, fence('markdown', await readText(path.join(dir, rel))));
  }

  if (guide) out.push('---', (await aiGuide()).replace(/^# /, '## '));
  return `${out.join('\n\n')}\n`;
}

// ── Workspace guide files ────────────────────────────────────────────────────

const MARK = /^<!-- docubrew-guide ([\w.-]+) sha:(\w+) -->\n/;

async function appVersion() {
  try { return JSON.parse(await fs.readFile(path.join(APP_ROOT, 'package.json'), 'utf8')).version; } catch { return '0'; }
}

/**
 * Write AGENTS.md (the guide) and CLAUDE.md (points to it) into the workspace.
 * Created if missing; refreshed when DocuBrew's guide changes, unless you've edited the file. `force` always rewrites.
 */
export async function writeWorkspaceGuide(ws, { force = false } = {}) {
  const body = await aiGuide();
  if (!body) return { written: [] };
  const version = await appVersion();
  const written = [];
  const files = {
    'AGENTS.md': body,
    'CLAUDE.md': 'This is a DocuBrew workspace. Read AGENTS.md before writing documents or styles here.\n\n@AGENTS.md\n',
  };
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(ws, name);
    const content = `<!-- docubrew-guide ${version} sha:${sha256(text).slice(0, 12)} -->\n${text}`;
    if (await exists(file)) {
      const current = await fs.readFile(file, 'utf8');
      const m = MARK.exec(current);
      const unedited = m && sha256(current.slice(m[0].length)).slice(0, 12) === m[2];
      if (!force && (!unedited || current === content)) continue;
    }
    await fs.writeFile(file, content);
    written.push(file);
  }
  return { written };
}

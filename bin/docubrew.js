#!/usr/bin/env node
// DocuBrew command line.
//
//   docubrew [start] [brew-folder]     start the app (opens your browser)
//   docubrew build <brew-folder>...    export PDFs without opening the app
//   docubrew new "<title>" --blend <id>
//   docubrew list                      list Brews and Blends in the workspace
//
// Options: --workspace <dir>  --port <n>  --no-open  -o/--out <file.pdf>
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server/server.js';
import { resolveWorkspace, ensureWorkspace, listBrews, listLibrary, createBrew } from '../src/core/workspace.js';
import { describeBrew, isBrew, DIST_DIR } from '../src/core/brew.js';
import { exportPdf } from '../src/core/pdf.js';
import { slugify } from '../src/core/util.js';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string', short: 'w' },
    port: { type: 'string', short: 'p' },
    open: { type: 'boolean', default: true },
    'no-open': { type: 'boolean' },
    out: { type: 'string', short: 'o' },
    blend: { type: 'string', short: 'b' },
    all: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const COMMANDS = ['start', 'build', 'new', 'list', 'help'];
let [command, ...args] = positionals;
if (!COMMANDS.includes(command)) {
  if (command) args.unshift(command);
  command = 'start';
}
if (opts.help) command = 'help';

const workspace = resolveWorkspace(opts.workspace);

try {
  await ({ start, build, new: create, list, help })[command]();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

async function start() {
  const server = await startServer({ workspace, port: Number(opts.port) || 4747, brew: args[0] });
  console.log(`\n  DocuBrew is running at ${server.url}`);
  console.log(`  Workspace: ${workspace}\n  Press Ctrl+C to stop.\n`);
  if (opts.open && !opts['no-open']) openBrowser(server.url);
  const stop = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function build() {
  await ensureWorkspace(workspace);
  let targets = args.map((a) => path.resolve(a));
  if (opts.all) {
    const roots = targets.length ? targets : [workspace];
    targets = [];
    for (const root of roots) {
      for (const e of await fs.readdir(root, { withFileTypes: true })) {
        const dir = path.join(root, e.name);
        if (e.isDirectory() && (await isBrew(dir))) targets.push(dir);
      }
    }
  }
  if (!targets.length) throw new Error('Usage: docubrew build <brew-folder> [-o out.pdf]   or   docubrew build --all [folder]');
  if (opts.out && targets.length > 1) throw new Error('--out only works with a single Brew.');

  const server = await startServer({ workspace, port: 0, quiet: true });
  try {
    for (const dir of targets) {
      await server.openBrew(dir);
      const info = await describeBrew(dir);
      const out = opts.out ? path.resolve(opts.out) : path.join(dir, DIST_DIR, `${slugify(info.title)}.pdf`);
      const r = await exportPdf(`${server.url}/preview/?mode=print`, out);
      console.log(`  ✓ ${info.title} → ${out}  (${r.pages} pages, ${(r.ms / 1000).toFixed(1)} s)`);
    }
  } finally {
    await server.close();
  }
}

async function create() {
  await ensureWorkspace(workspace);
  const title = args.join(' ');
  if (!title || !opts.blend) {
    const blends = (await listLibrary(workspace)).filter((b) => !b.abstract).map((b) => b.id).join(', ');
    throw new Error(`Usage: docubrew new "<title>" --blend <id>\n  Blends: ${blends}`);
  }
  const info = await createBrew(workspace, { title, blend: opts.blend });
  console.log(`  ✓ Created ${info.path}`);
}

async function list() {
  await ensureWorkspace(workspace);
  console.log(`\n  Workspace: ${workspace}\n\n  Brews`);
  for (const b of await listBrews(workspace)) console.log(`    ${b.folder.padEnd(32)} ${b.title}`);
  console.log('\n  Blends');
  for (const b of await listLibrary(workspace)) console.log(`    ${b.id.padEnd(32)} ${b.version || ''}${b.abstract ? '  (base)' : ''}`);
  console.log('');
}

async function help() {
  console.log(`
  DocuBrew — Markdown + CSS → print-ready PDF

  docubrew [brew-folder]              start the app and open your browser
  docubrew build <brew-folder>        export a PDF to <brew>/dist/
  docubrew build --all [folder]       export every Brew in a folder (default: workspace)
  docubrew new "<title>" --blend <id> create a Brew in the workspace
  docubrew list                       list Brews and Blends

  --workspace, -w <dir>   workspace folder (default: ~/Documents/DocuBrew, or $DOCUBREW_WORKSPACE)
  --port, -p <n>          port for the app (default 4747)
  --no-open               don't open the browser
  --out, -o <file>        PDF path for a single build
`);
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  spawn(cmd, { shell: true, detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

#!/usr/bin/env node
// DocuBrew command line.
//
//   docubrew [start] [brew-folder]     start the app (opens your browser)
//   docubrew build <brew-folder>...    export PDFs without opening the app
//       --out-dir <dir>  --set key=value  --data records.yaml|json|csv  --name "{{machine.serial}}"
//   docubrew pack <brew-folder>...     save each Brew as a single .brew file
//   docubrew unpack <file.brew>...     import .brew files into the workspace
//   docubrew new "<title>" --blend <id>
//   docubrew list                      list Brews and Blends in the workspace
//   docubrew sample                    add the bundled sample Brews back to the workspace
//   docubrew blend status [brew]...    is each Brew's Blend copy up to date with the Library?
//   docubrew blend update <brew>...    copy the current Library Blend into the Brew
//   docubrew blend reset <id>...       replace a Library Blend with the version bundled with DocuBrew
//
// Options: --workspace <dir>  --port <n>  --no-open  -o/--out <file.pdf>
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server/server.js';
import { resolveWorkspace, ensureWorkspace, listBrews, listLibrary, createBrew, restoreSamples, libraryDir, attachBlend, resetBundledBlend } from '../src/core/workspace.js';
import { blendStatus } from '../src/core/blend-status.js';
import { describeBrew, isBrew, readBrewManifest, expandText, DIST_DIR } from '../src/core/brew.js';
import { exportPdf } from '../src/core/pdf.js';
import { slugify, deepMerge } from '../src/core/util.js';
import { packBrew, unpackBrew } from '../src/core/brewfile.js';
import { parseSets, loadRecords, fileNameFrom } from '../src/core/data.js';

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
    'out-dir': { type: 'string' },
    set: { type: 'string', multiple: true },
    data: { type: 'string', short: 'd' },
    name: { type: 'string', short: 'n' },
    into: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const COMMANDS = ['start', 'build', 'new', 'list', 'sample', 'blend', 'pack', 'unpack', 'help'];
let [command, ...args] = positionals;
if (!COMMANDS.includes(command)) {
  if (command) args.unshift(command);
  command = 'start';
}
if (opts.help) command = 'help';

const workspace = resolveWorkspace(opts.workspace);

try {
  await ({ start, build, new: create, list, sample, blend, pack, unpack, help })[command]();
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
  if (opts.out && (targets.length > 1 || opts.data)) throw new Error('--out only works for a single PDF. Use --out-dir (and --name) instead.');
  if (opts.data && targets.length > 1) throw new Error('--data works with one Brew at a time.');

  const sets = parseSets(opts.set);
  // One job per record with --data, otherwise one per Brew.
  const records = opts.data ? await loadRecords(path.resolve(opts.data)) : [null];
  const outDir = opts['out-dir'] ? path.resolve(opts['out-dir']) : null;

  const server = await startServer({ workspace, port: 0, quiet: true });
  let ok = 0;
  let failed = 0;
  try {
    for (const dir of targets) {
      await server.openBrew(dir);
      const info = await describeBrew(dir);
      const used = new Set();
      for (const [i, record] of records.entries()) {
        const vars = deepMerge(record || {}, sets);
        server.state.varsOverride = Object.keys(vars).length ? vars : null;
        // File name: --name pattern, else the title (+ record number for batches)
        const brewVars = (await readBrewManifest(dir)).variables || {};
        const merged = deepMerge(brewVars, vars);
        const title = expandText(vars.title || (await readBrewManifest(dir)).title || info.title, merged);
        const all = deepMerge({ ...merged, title, index: i + 1, folder: path.basename(dir) }, {});
        let name = opts.name ? fileNameFrom(opts.name, all) : `${slugify(all.title)}${record ? `-${i + 1}` : ''}.pdf`;
        if (used.has(name)) name = name.replace(/\.pdf$/, `-${i + 1}.pdf`);
        used.add(name);
        const out = opts.out ? path.resolve(opts.out) : path.join(outDir || path.join(dir, DIST_DIR), name);
        try {
          const r = await exportPdf(`${server.url}/preview/?mode=print`, out);
          ok++;
          console.log(`  ✓ ${record ? `[${i + 1}/${records.length}] ` : ''}${title} → ${out}  (${r.pages} pages, ${(r.ms / 1000).toFixed(1)} s)`);
        } catch (err) {
          failed++;
          console.log(`  ✗ ${record ? `[${i + 1}/${records.length}] ` : ''}${title}: ${err.message}`);
        }
      }
    }
  } finally {
    await server.close();
  }
  if (ok + failed > 1) console.log(`\n  ${ok} exported${failed ? `, ${failed} failed` : ''}.`);
  if (failed) process.exitCode = 1;
}

async function pack() {
  if (!args.length) throw new Error('Usage: docubrew pack <brew-folder>... [-o file.brew]');
  if (opts.out && args.length > 1) throw new Error('--out only works with a single Brew.');
  for (const a of args) {
    const r = await packBrew(path.resolve(a), opts.out ? path.resolve(opts.out) : undefined);
    console.log(`  ✓ ${r.file}  (${r.files} files, ${Math.round(r.bytes / 1024)} KB)`);
  }
}

async function unpack() {
  if (!args.length) throw new Error('Usage: docubrew unpack <file.brew>... [--name folder] [--into dir]');
  if (opts.name && args.length > 1) throw new Error('--name only works with a single file.');
  await ensureWorkspace(workspace);
  const into = opts.into ? path.resolve(opts.into) : workspace;
  for (const a of args) {
    const info = await unpackBrew(await fs.readFile(path.resolve(a)), into, { name: opts.name });
    console.log(`  ✓ ${path.basename(a)} → ${info.path}${info.renamed ? '  (that name was taken)' : ''}`);
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

async function sample() {
  await ensureWorkspace(workspace);
  const added = await restoreSamples(workspace);
  if (!added.length) console.log('  All sample Brews are already in the workspace.');
  for (const b of added) console.log(`  ✓ Added ${b.path}`);
}

async function blend() {
  const [action, ...targets] = args;
  if (!['status', 'update', 'reset'].includes(action)) throw new Error('Usage: docubrew blend status [brew]...  |  docubrew blend update <brew>...  |  docubrew blend reset <blend-id>...');
  await ensureWorkspace(workspace);
  if (action === 'reset') {
    if (!targets.length) throw new Error('Name the bundled Blend(s) to reset, e.g. docubrew blend reset typewriter-base typewriter-sop');
    for (const id of targets) {
      const b = await resetBundledBlend(workspace, id);
      console.log(`  ✓ ${id} reset to the bundled version ${b.version}. Brews using it will offer the update.`);
    }
    return;
  }
  let dirs = targets.map((t) => path.resolve(t));
  if (!dirs.length) {
    if (action === 'update') throw new Error('Name the Brew folder(s) to update.');
    dirs = (await listBrews(workspace)).map((b) => b.path);
  }
  for (const dir of dirs) {
    const s = await blendStatus(libraryDir(workspace), dir);
    const name = path.basename(dir).padEnd(32);
    if (action === 'status') {
      const note = s.state === 'current' ? 'up to date'
        : s.state === 'out-of-date' ? `update available: ${s.version === s.libraryVersion ? `Library Blend changed since ${s.version}` : `${s.version} → ${s.libraryVersion}`}${s.locallyModified ? ' (copy was edited by hand)' : ''}`
        : s.state === 'missing' ? `Blend "${s.source}" isn't in the Library` : 'no Blend';
      console.log(`  ${name} ${s.source || ''}  ${note}`);
    } else {
      if (!s.source || s.state === 'missing') { console.log(`  ✗ ${name} no Library Blend to update from`); continue; }
      if (s.state === 'current') { console.log(`  ✓ ${name} already up to date`); continue; }
      await attachBlend(workspace, dir, s.source);
      console.log(`  ✓ ${name} updated to ${s.source} ${s.libraryVersion}${s.locallyModified ? ' (hand edits to the copy were replaced)' : ''}`);
    }
  }
}

async function help() {
  console.log(`
  DocuBrew — Markdown + CSS → print-ready PDF

  docubrew [brew-folder]              start the app and open your browser
  docubrew build <brew-folder>        export a PDF to <brew>/dist/
  docubrew build --all [folder]       export every Brew in a folder (default: workspace)
      --out-dir <dir>                 put the PDFs in one folder
      --set key=value                 override a variable (repeatable), e.g. --set machine.serial=1234
      --data <file>                   one PDF per record in a .yaml/.json/.csv file
      --name "<pattern>"              file names, e.g. "{{machine.model}}-{{machine.serial}}"
  docubrew pack <brew-folder>         save a Brew as one .brew file (in its dist/ folder, or -o)
  docubrew unpack <file.brew>         import a .brew into the workspace (--name, --into)
  docubrew new "<title>" --blend <id> create a Brew in the workspace
  docubrew list                       list Brews and Blends
  docubrew sample                     add the bundled sample Brews back to the workspace
  docubrew blend status [brew]        check Brews' Blend copies against the Library
  docubrew blend update <brew>        update a Brew's Blend copy from the Library
  docubrew blend reset <id>           replace a Library Blend with the version bundled with DocuBrew

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

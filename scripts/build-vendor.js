// Bundle browser dependencies that need a bundler (CodeMirror 6) into app/vendor/.
// Run after changing app/vendor-src/ or upgrading CodeMirror:  npm run build:vendor
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'app/vendor-src/codemirror.js')],
  outfile: path.join(root, 'app/vendor/codemirror.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  legalComments: 'eof',
  logLevel: 'info',
});

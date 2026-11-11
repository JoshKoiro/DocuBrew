// Minimal static file serving with path-traversal protection.
import fs from 'node:fs/promises';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.brew': 'application/zip',
};

/** Resolve `rel` inside `root`, or return null if it escapes. */
export function safeJoin(root, rel) {
  const decoded = decodeURIComponent(rel).replace(/^[/\\]+/, '');
  const full = path.resolve(root, decoded);
  const r = path.resolve(root);
  if (full !== r && !full.startsWith(r + path.sep)) return null;
  return full;
}

export async function sendFile(res, file, { transform, headers = {} } = {}) {
  let data;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    data = await fs.readFile(file);
  } catch {
    return false;
  }
  if (transform) data = transform(data.toString('utf8'));
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
    // .brew files are for saving, not viewing
    ...(ext === '.brew' ? { 'content-disposition': `attachment; filename="${path.basename(file).replace(/"/g, '')}"` } : {}),
    ...headers,
  });
  res.end(data);
  return true;
}

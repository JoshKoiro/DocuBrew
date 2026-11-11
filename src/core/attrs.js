// Edit markdown-it-attrs blocks ({#id .class}) on a Markdown block, given its line range.
//
//   heading, paragraph, figure:  attributes at the end of the block's last line   "## Title {#id .cls}"
//   list, table:                 a blank line, then attributes on their own line  "{.spec}"
//
// Lines are 1-based and refer to the whole file (front matter included), matching data-source-line/-end.

export const ATTR_KINDS = ['heading', 'paragraph', 'figure', 'list', 'table'];

const TRAILING = /(\s*)\{([^{}]*)\}\s*$/;      // attrs at end of a line
const OWN_LINE = /^\s*\{([^{}]*)\}\s*$/;        // attrs alone on a line

/** Parse "#id .a .b key=val" into { id, classes, rest }. */
export function parseAttrs(src) {
  const out = { id: null, classes: [], rest: [] };
  for (const tok of String(src).trim().match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    if (tok.startsWith('#')) out.id = tok.slice(1);
    else if (tok.startsWith('.')) out.classes.push(tok.slice(1));
    else out.rest.push(tok);
  }
  return out;
}

export function formatAttrs({ id, classes, rest }) {
  const parts = [];
  if (id) parts.push(`#${id}`);
  for (const c of classes) parts.push(`.${c}`);
  parts.push(...rest);
  return parts.length ? `{${parts.join(' ')}}` : '';
}

/**
 * Read the attributes currently on a block.
 * @returns {{ id, classes, rest }}
 */
export function readBlockAttrs(text, { line = 1, end, kind }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (end > line && lines[end - 1].trim() === '') end--;
  const loc = locate(lines, end, kind);
  return loc.existing ? parseAttrs(loc.existing) : { id: null, classes: [], rest: [] };
}

/**
 * Change a block's attributes. `edit` receives { id, classes, rest } and mutates it.
 * Returns the new file text.
 */
export function editBlockAttrs(text, { line, end, kind }, edit) {
  if (!ATTR_KINDS.includes(kind)) throw new Error(`Can't add attributes to a ${kind} from the inspector — use "all of this kind" instead.`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (!(line >= 1 && end >= line && end <= lines.length)) throw new Error(`Line range ${line}–${end} is outside the file. Save and try again.`);

  // Block ranges can include trailing blank lines (lists do); work from the last line with content.
  while (end > line && lines[end - 1].trim() === '') end--;
  const loc = locate(lines, end, kind);
  const attrs = loc.existing ? parseAttrs(loc.existing) : { id: null, classes: [], rest: [] };
  edit(attrs);
  attrs.classes = [...new Set(attrs.classes.filter(Boolean))];
  const formatted = formatAttrs(attrs);

  if (kind === 'list' || kind === 'table') {
    if (loc.ownLine != null) {
      if (formatted) lines[loc.ownLine] = formatted;
      else if (loc.ownLine > end && lines[loc.ownLine - 1].trim() === '') lines.splice(loc.ownLine - 1, 2); // attrs line + blank before it
      else lines.splice(loc.ownLine, 1);
    } else if (formatted) {
      lines.splice(end, 0, '', formatted); // after the block: blank line, then attrs
    }
  } else {
    const i = end - 1;
    const base = lines[i].replace(TRAILING, '');
    lines[i] = formatted ? `${base} ${formatted}` : base;
  }
  return lines.join(eol);
}

function locate(lines, end, kind) {
  if (kind === 'list' || kind === 'table') {
    // "{…}" after one blank line, or directly after the block
    for (const idx of [end + 1, end]) {
      const l = lines[idx];
      if (l != null && OWN_LINE.test(l) && (idx === end || lines[end].trim() === '')) {
        return { existing: OWN_LINE.exec(l)[1], ownLine: idx };
      }
    }
    return { existing: null, ownLine: null };
  }
  const m = TRAILING.exec(lines[end - 1] || '');
  // Ignore things like "{{ variable }}" or a stray "}" in prose: only treat "{#…}" / "{.…}" as attributes.
  if (m && /^\s*[#.]/.test(m[2]) && !/\}\}\s*$/.test(lines[end - 1])) return { existing: m[2] };
  return { existing: null };
}

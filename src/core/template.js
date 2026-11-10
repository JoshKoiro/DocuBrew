// A deliberately tiny template engine for Blend HTML templates.
//
//   {{ path.to.value }}        escaped value
//   {{{ path.to.value }}}      raw HTML
//   {{#if path}} … {{else}} … {{/if}}
//   {{#each list}} … {{ this }} / {{ this.field }} / {{ @index }} … {{/each}}
//
// Unknown values render as empty strings. Swap for Eta/Handlebars later if templates outgrow it.
import { escapeHtml, getPath } from './util.js';

function lookup(ctx, key) {
  key = key.trim();
  if (key === 'this') return ctx.this;
  if (key.startsWith('this.')) return getPath(ctx.this, key.slice(5));
  if (key === '@index') return ctx['@index'];
  return getPath(ctx, key);
}

function truthy(v) {
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
}

// Find the matching {{/tag}} for a block starting at `from`, honoring nesting.
function findClose(src, tag, from) {
  const re = new RegExp(`{{\\s*(#${tag}\\b|/${tag})\\s*[^}]*}}`, 'g');
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(src))) {
    depth += m[1].startsWith('#') ? 1 : -1;
    if (depth === 0) return { start: m.index, end: re.lastIndex };
  }
  throw new Error(`Template error: missing {{/${tag}}}`);
}

// Split an #if body on its own top-level {{else}}.
function splitElse(body) {
  const re = /{{\s*(#if\b|\/if|else)\s*[^}]*}}/g;
  let depth = 0, m;
  while ((m = re.exec(body))) {
    if (m[1] === '#if') depth++;
    else if (m[1] === '/if') depth--;
    else if (depth === 0) return [body.slice(0, m.index), body.slice(re.lastIndex)];
  }
  return [body, ''];
}

export function renderTemplate(src, ctx) {
  let out = '';
  let i = 0;
  const open = /{{\s*#(if|each)\s+([^}]+?)\s*}}/g;
  let m;
  while ((m = open.exec(src))) {
    out += interpolate(src.slice(i, m.index), ctx);
    const [, tag, key] = m;
    const close = findClose(src, tag, open.lastIndex);
    const body = src.slice(open.lastIndex, close.start);
    const value = lookup(ctx, key);
    if (tag === 'if') {
      const [yes, no] = splitElse(body);
      out += renderTemplate(truthy(value) ? yes : no, ctx);
    } else if (Array.isArray(value)) {
      value.forEach((item, idx) => { out += renderTemplate(body, { ...ctx, this: item, '@index': idx }); });
    }
    i = close.end;
    open.lastIndex = close.end;
  }
  return out + interpolate(src.slice(i), ctx);
}

function interpolate(src, ctx) {
  return src
    .replace(/{{{\s*([^}]+?)\s*}}}/g, (_, k) => String(lookup(ctx, k) ?? ''))
    .replace(/{{\s*([^#/}][^}]*?)\s*}}/g, (_, k) => escapeHtml(lookup(ctx, k) ?? ''));
}

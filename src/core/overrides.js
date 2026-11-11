// The inspector's rules live in a marked section of overrides.css, so hand-written CSS
// elsewhere in the file is never touched. Hand edits inside the section are kept too,
// as long as they stay simple "selector { property: value; }" rules (comments inside are dropped).

export const SECTION_START = '/* ── DocuBrew visual edits ─────────────────────────────────────────────\n   Written by the inspector. Edit freely; keep to simple "selector { prop: value; }" rules. */';
export const SECTION_END = '/* ── end DocuBrew visual edits ── */';

const START_RE = /\/\*\s*── DocuBrew visual edits[\s\S]*?\*\//;
const END_RE = /\/\*\s*── end DocuBrew visual edits ──\s*\*\//;

/** Split overrides.css into the text before, the managed section's body, and the text after. */
function split(css) {
  const start = START_RE.exec(css);
  if (!start) return { before: css, body: '', after: '', found: false };
  const rest = css.slice(start.index + start[0].length);
  const end = END_RE.exec(rest);
  if (!end) return { before: css.slice(0, start.index), body: rest, after: '', found: true };
  return {
    before: css.slice(0, start.index),
    body: rest.slice(0, end.index),
    after: rest.slice(end.index + end[0].length),
    found: true,
  };
}

/** Parse "selector { a: b; c: d }" rules. Returns an ordered array of { selector, decls: Map }. */
export function parseRules(body) {
  const rules = [];
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = normalizeSelector(m[1]);
    if (!selector) continue;
    const decls = new Map();
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const prop = part.slice(0, i).trim().toLowerCase();
      const value = part.slice(i + 1).trim();
      if (prop && value) decls.set(prop, value);
    }
    const existing = rules.find((r) => r.selector === selector);
    if (existing) for (const [k, v] of decls) existing.decls.set(k, v);
    else rules.push({ selector, decls });
  }
  return rules;
}

function serialize(rules) {
  return rules
    .filter((r) => r.decls.size)
    .map((r) => `${r.selector} {\n${[...r.decls].map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}`)
    .join('\n\n');
}

export function normalizeSelector(s) {
  return String(s).trim().replace(/\s+/g, ' ');
}

/** Current declarations for a selector in the managed section. */
export function getRule(css, selector) {
  const { body } = split(css);
  const rule = parseRules(body).find((r) => r.selector === normalizeSelector(selector));
  return rule ? Object.fromEntries(rule.decls) : {};
}

/** All managed rules, for listing in the inspector. */
export function listRules(css) {
  return parseRules(split(css).body).map((r) => ({ selector: r.selector, decls: Object.fromEntries(r.decls) }));
}

/**
 * Set or remove declarations. `changes` maps property → value; null/'' removes it.
 * Returns the new overrides.css text.
 */
export function setRule(css, selector, changes) {
  selector = normalizeSelector(selector);
  if (!selector || /[{}]/.test(selector)) throw new Error(`Invalid selector: ${selector}`);
  const { before, body, after, found } = split(css);
  const rules = parseRules(body);
  let rule = rules.find((r) => r.selector === selector);
  if (!rule) {
    rule = { selector, decls: new Map() };
    rules.push(rule);
  }
  for (const [prop, value] of Object.entries(changes)) {
    const p = String(prop).trim().toLowerCase();
    if (!/^-?[a-z][a-z-]*$/.test(p)) throw new Error(`Invalid property: ${prop}`);
    const v = value == null ? '' : String(value).trim();
    if (/[{};]/.test(v)) throw new Error(`Invalid value for ${p}: ${v}`);
    if (v) rule.decls.set(p, v);
    else rule.decls.delete(p);
  }
  const section = `${SECTION_START}\n\n${serialize(rules)}\n\n${SECTION_END}`;
  if (!found) {
    const base = css.replace(/\s*$/, '');
    return `${base}${base ? '\n\n' : ''}${section}\n`;
  }
  return `${before}${section}${after}`;
}

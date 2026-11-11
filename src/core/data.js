// Data for batch builds: records from YAML, JSON or CSV, and "--set key=value" overrides.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { renderTemplate } from './template.js';

/** Set a dotted key ("machine.serial") on an object, creating nested objects as needed. */
export function setPath(obj, dotted, value) {
  const keys = dotted.split('.').filter(Boolean);
  let o = obj;
  keys.slice(0, -1).forEach((k) => { if (typeof o[k] !== 'object' || o[k] === null || Array.isArray(o[k])) o[k] = {}; o = o[k]; });
  o[keys[keys.length - 1]] = value;
  return obj;
}

/** Turn a flat record with dotted keys into nested objects. Values that look like YAML ("[a, b]", "42") are parsed. */
export function unflatten(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) setPath(out, k, typeof v === 'string' ? parseScalar(v) : v);
  return out;
}

function parseScalar(v) {
  const t = v.trim();
  if (t === '') return '';
  if (/^[[{]/.test(t) || /^(true|false|null|-?\d+(\.\d+)?)$/.test(t)) {
    try { return YAML.parse(t); } catch { return v; }
  }
  return v;
}

/** "--set machine.serial=12345" (repeatable) → { machine: { serial: 12345 } } */
export function parseSets(sets = []) {
  const out = {};
  for (const s of [].concat(sets)) {
    const i = s.indexOf('=');
    if (i < 1) throw new Error(`--set needs key=value, got "${s}"`);
    setPath(out, s.slice(0, i).trim(), parseScalar(s.slice(i + 1)));
  }
  return out;
}

/** Minimal RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  if (!rows.length) return [];
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

/** Load records from .yaml/.yml/.json/.csv. YAML/JSON may be a list, or an object with a `records` list. */
export async function loadRecords(file) {
  const text = await fs.readFile(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  let records;
  if (ext === '.csv') records = parseCsv(text);
  else if (ext === '.json') records = JSON.parse(text);
  else if (ext === '.yaml' || ext === '.yml') records = YAML.parse(text);
  else throw new Error(`--data must be a .yaml, .yml, .json or .csv file (got ${ext || 'no extension'})`);
  if (records && !Array.isArray(records) && Array.isArray(records.records)) records = records.records;
  if (!Array.isArray(records) || !records.length) throw new Error(`${path.basename(file)} has no records (expected a list).`);
  return records.map((r) => unflatten(r));
}

/** Render a file-name pattern like "{{machine.model}}-{{machine.serial}}" and make it safe for any OS. */
export function fileNameFrom(pattern, vars, ext = '.pdf') {
  // Raw values ({{{ }}}): file names aren't HTML, so "&" must stay "&".
  const raw = pattern.replace(/(?<!{){{(?!{)\s*([^#/{}][^}]*?)\s*}}/g, '{{{ $1 }}}');
  let name = renderTemplate(raw, vars)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '');
  if (!name) name = 'document';
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

#!/usr/bin/env node
/**
 * I9 copy lint. Fails the build.
 *
 * § 1812.5095(g): a nurses' registry must not hold itself out as the employer of the
 * providers it refers, and must not characterise them as its contractors either.
 * Providers are *referred providers*.
 *
 * The lint reads only text that can reach a human: string literals, template literals
 * and JSX text. Comments are stripped first, deliberately — the statutory words belong
 * in comments explaining why the rule exists, and flagging those would push the
 * explanation out of the code.
 *
 * It also rejects table and route names that would imply a capability the invariants
 * forbid (I1 training, I2 work direction, I7 corrective workflows, I8 asset issuing).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = process.cwd();
const COPY_DIRS = ['app', 'components', 'content'];
const IDENTIFIER_DIRS = ['app', 'components', 'content', 'lib'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.md', '.json', '.sql']);

/** I9 — forbidden in any operator-, provider- or client-facing copy. */
const FORBIDDEN_COPY = [
  'independent contractor',
  'self-employed',
  'our nurses',
  'our caregivers',
  'our staff',
  'our employees',
  'employee',
];

/** I1, I2, I7, I8 — forbidden identifiers, whatever they are attached to. */
const FORBIDDEN_IDENTIFIERS = [
  { pattern: /\b(?:training|course|module|curriculum|competency)(?:s|_[a-z_]+)?\b/gi, invariant: 'I1' },
  { pattern: /\b(?:care_plan|careplan|task|tasks|duty|duties|checklist)(?:_[a-z_]+)?\b/gi, invariant: 'I2' },
  { pattern: /\b(?:performance_review|coaching|corrective_action|discipline|write_up)\b/gi, invariant: 'I7' },
  { pattern: /\b(?:uniform|badge|equipment_assignment|device_assignment|inventory)\b/gi, invariant: 'I8' },
];

/**
 * Strip comments without disturbing string contents. A hand-rolled scan rather than a
 * regex, because `'https://x'` and `"/* not a comment *\/"` both defeat the regex version.
 */
function stripComments(source, ext) {
  if (ext === '.md') return source;                  // Markdown has no comment syntax here
  let out = '';
  let i = 0;
  const n = source.length;
  let state = 'code';
  let quote = '';

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ext === '.sql' && c === '-' && next === '-') { state = 'line'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'string'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n';                    // keep line numbers honest
      i++; continue;
    }
    // state === 'string'
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    if (c === quote) { state = 'code'; quote = ''; out += c; i++; continue; }
    out += c; i++; continue;
  }
  return out;
}

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (EXTENSIONS.has(extname(name))) acc.push(full);
  }
  return acc;
}

function locate(text, index) {
  const upto = text.slice(0, index);
  const line = upto.split('\n').length;
  const col = index - upto.lastIndexOf('\n');
  return { line, col };
}

const findings = [];

for (const dir of COPY_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const raw = readFileSync(file, 'utf8');
    const text = stripComments(raw, extname(file));
    const haystack = text.toLowerCase();
    for (const phrase of FORBIDDEN_COPY) {
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(phrase, from);
        if (at === -1) break;
        const { line, col } = locate(text, at);
        findings.push({
          file: relative(ROOT, file), line, col, invariant: 'I9',
          message: `forbidden copy "${phrase}" — providers are referred providers`,
        });
        from = at + phrase.length;
      }
    }
  }
}

for (const dir of IDENTIFIER_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const ext = extname(file);
    if (ext === '.md') continue;                      // documentation names what it forbids
    const raw = readFileSync(file, 'utf8');
    const text = stripComments(raw, ext);
    for (const { pattern, invariant } of FORBIDDEN_IDENTIFIERS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        const { line, col } = locate(text, m.index);
        findings.push({
          file: relative(ROOT, file), line, col, invariant,
          message: `forbidden identifier "${m[0]}" — see ${invariant} in /INVARIANTS.md`,
        });
      }
    }
  }
}

if (findings.length === 0) {
  console.log('copy lint: clean (I1, I2, I7, I8, I9)');
  process.exit(0);
}

console.error(`copy lint: ${findings.length} violation${findings.length === 1 ? '' : 's'}\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}:${f.col}  [${f.invariant}]  ${f.message}`);
}
console.error('\nThese are statutory invariants, not style rules. See /INVARIANTS.md.');
process.exit(1);

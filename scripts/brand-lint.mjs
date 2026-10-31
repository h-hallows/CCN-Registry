#!/usr/bin/env node
/**
 * No literal business name in the codebase. Work order 01 § 3.
 *
 * The trading name is blocked on counsel — HSC § 1726(b), 22 CCR § 74600(b), and
 * Civ. Code § 1812.533(b)(4), which bars presenting as a home care agency by name,
 * advertising or other representation. If the name turns out not to be usable, a
 * hardcoded one is a find-and-replace across every page and six statutory documents,
 * with the statutory ones being the dangerous half.
 *
 * Everything imports from lib/brand.ts instead, and this fails the build if anything
 * stops doing so.
 *
 *   node scripts/brand-lint.mjs <dir...>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

/**
 * Candidate names, and fragments of them. Add any further candidate here rather than
 * relying on the full string: "Century City Concierge" alone is just as much a
 * representation as the full name under § 1812.533(b)(4).
 */
const CANDIDATE_NAMES = [
  'Century City Concierge Nursing',
  'Century City Concierge',
  'CCN Nursing',
  'Concierge Nursing',
];

/** lib/brand.ts is where the name is allowed to be named. Nowhere else. */
const ALLOWED = ['lib/brand.ts'];

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.md', '.mdx', '.json', '.css', '.svg']);

const ROOT = process.cwd();
const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: brand-lint <dir> [dir...]');
  process.exit(2);
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

const findings = [];
for (const target of targets) {
  for (const file of walk(resolve(ROOT, target))) {
    const rel = relative(ROOT, file);
    if (ALLOWED.some((a) => rel.endsWith(a))) continue;
    const text = readFileSync(file, 'utf8');
    for (const candidate of CANDIDATE_NAMES) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(candidate, from);
        if (at === -1) break;
        const line = text.slice(0, at).split('\n').length;
        findings.push({ rel, line, candidate });
        from = at + candidate.length;
      }
    }
  }
}

if (findings.length === 0) {
  console.log(`brand lint: clean — ${targets.join(' ')}`);
  process.exit(0);
}

console.error(`brand lint: ${findings.length} literal business name${findings.length === 1 ? '' : 's'}\n`);
for (const f of findings) {
  console.error(`  ${f.rel}:${f.line}  "${f.candidate}" — import LEGAL_NAME or DISPLAY_NAME from lib/brand`);
}
console.error('\nThe trading name is blocked on counsel. See work order 01 § 3.');
process.exit(1);

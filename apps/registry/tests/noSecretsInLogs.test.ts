/**
 * A sign-in link must not reach the server log.
 *
 * Both applications used to print them, with a comment saying a mail provider goes here.
 * The mailer is now in `@h-hallows/core/mail` and refuses to print in production — but
 * nothing stops the next `console.log` from putting one back, and the symptom is
 * invisible: the page behaves correctly and the credential is simply also in the log,
 * where a platform collaborator, a log drain or an aggregator can read it for as long as
 * the retention window lasts.
 *
 * So this reads the source. It is a source-level rule because there is no runtime moment
 * at which the mistake is observable.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['app', 'lib', 'components'];

/** Words that mean a bearer credential in this codebase. */
const SECRET = /\b(url|token|link|invite|magic|hash)\b/i;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** Every console.* call, as the text between its parentheses. */
function consoleCalls(source: string): { at: number; args: string }[] {
  const found: { at: number; args: string }[] = [];
  const call = /console\.(log|info|warn|error|debug)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source)) !== null) {
    let depth = 1;
    let i = call.lastIndex;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    found.push({
      at: source.slice(0, match.index).split('\n').length,
      args: source.slice(call.lastIndex, i - 1),
    });
  }
  return found;
}

describe('nothing logs a credential', () => {
  const files = ROOTS.flatMap((r) => sources(r));

  it('finds the source to read', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no console call anywhere mentions a link, token or hash', () => {
    const offences: string[] = [];
    for (const file of files) {
      for (const { at, args } of consoleCalls(readFileSync(file, 'utf8'))) {
        if (SECRET.test(args)) offences.push(`${file}:${at} — console(${args.trim()})`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('the sign-in page sends rather than prints, and gates on configuration first', () => {
    const page = readFileSync('app/login/page.tsx', 'utf8');
    // Call sites, not the word: the message body says "the registry console".
    expect(consoleCalls(page)).toEqual([]);
    expect(page).toContain('sendMail');

    /*
     * Order matters, and this asserts it. Whether a mailer exists is the same fact for
     * every address; whether a link was issued is not. Checking configuration after the
     * lookup would turn this public form into a way to find out which addresses are on
     * file.
     */
    expect(page.indexOf('mailConfigured()')).toBeGreaterThan(-1);
    expect(page.indexOf('mailConfigured()'))
      .toBeLessThan(page.indexOf('await requestMagicLink'));
  });

  it('the issued portal link is handed back, never written to the audit diff', () => {
    const access = readFileSync('lib/domain/portalAccess.ts', 'utf8');
    expect(consoleCalls(access)).toEqual([]);
    // The audit row records that a link was issued, to whom and when. Not the link.
    const diffs = access.match(/diff: \{[\s\S]*?\n {4}\}/g) ?? [];
    expect(diffs.length).toBeGreaterThan(0);
    for (const diff of diffs) {
      expect(diff).not.toContain('url');
      expect(diff).not.toContain('token');
    }
  });
});

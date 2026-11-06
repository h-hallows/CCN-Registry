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

/**
 * Every mutation in this console is behind the operator check.
 *
 * `requireOperator()` is the only authorization this application has: there are no
 * per-action roles, because there is one audience. That makes the check uniform and
 * therefore easy to leave out of the twenty-third action — and a server action with no
 * check is callable by anyone who can reach the deployment, since Next exposes each one
 * as its own endpoint whether or not a page renders its form.
 *
 * Nothing observable goes wrong when it is missing until somebody notices, so the rule
 * is asserted over the file rather than per action.
 */
describe('every server action is behind the operator check', () => {
  const source = readFileSync('app/(app)/actions.ts', 'utf8');

  function actions(): { name: string; body: string }[] {
    const out: { name: string; body: string }[] = [];
    const re = /export async function (\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    const starts: { name: string; at: number }[] = [];
    while ((match = re.exec(source)) !== null) {
      starts.push({ name: match[1]!, at: match.index });
    }
    for (const [i, s] of starts.entries()) {
      out.push({
        name: s.name,
        body: source.slice(s.at, starts[i + 1]?.at ?? source.length),
      });
    }
    return out;
  }

  it('finds the actions to check', () => {
    expect(actions().length).toBeGreaterThan(15);
  });

  it('calls requireOperator before anything else', () => {
    const missing = actions()
      .filter((a) => !a.body.includes('await requireOperator()'))
      .map((a) => a.name);
    expect(missing).toEqual([]);
  });

  it('reads the actor from the session, never from the form', () => {
    /*
     * `ctx.actor` is what every audit row and timeline entry is attributed to. Taking
     * it from a form field would let the caller sign somebody else's name to a
     * permanent record — and these records are the § 1812.5095 evidence.
     */
    for (const action of actions()) {
      expect(action.body, `${action.name} reads an actor from the form`)
        .not.toMatch(/form\.get\(['"](actor|operator|author|uploadedBy|disclosedBy)['"]\)/);
    }
  });
});

describe('the document download route', () => {
  const route = readFileSync('app/(app)/documents/[documentId]/route.ts', 'utf8');

  it('checks the operator before it reads anything', () => {
    expect(route.indexOf('requireOperator()')).toBeLessThan(route.indexOf('readDocument('));
  });
});

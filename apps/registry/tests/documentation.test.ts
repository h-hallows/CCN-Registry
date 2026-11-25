/**
 * The deployment instructions, checked the way a route is checked.
 *
 * THE FAILURE THIS FILE IS ABOUT. `PORTAL_URL` is read by `portalOrigin()` and decides
 * where a family is sent when this console grants them access to their own screen. It
 * was named in README.md's deployment steps and appeared nowhere in `.env.example`, so
 * the one file an operator copies when standing a deployment up did not mention it, and
 * its absence had no symptom: the link was built against `http://localhost:3003` and
 * everything else about the grant succeeded.
 *
 * At the same time, two passages told the reader a sign-in link could be read out of the
 * function logs. That had been true of an earlier build and was made false on purpose —
 * a magic link is a bearer credential and a log is read by collaborators, drains and
 * aggregators. An operator following those passages would have hunted for a link that
 * is never printed, and might reasonably have tried to make it print again.
 *
 * Both are the console's own signature failure one layer out. The code was correct,
 * tested and green; the documentation sent somebody around it. So the documentation is
 * tested too, and as rules rather than as those three instances: the names it uses must
 * resolve, and it must not describe a practice the code refuses.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The repository root, two levels above this app. */
const REPO = new URL('../../../', import.meta.url).pathname;
const APP = new URL('../', import.meta.url).pathname;

const read = (p: string) => readFileSync(p, 'utf8');

const docs = readdirSync(REPO)
  .filter((n) => n.endsWith('.md'))
  .map((name) => ({ name, text: read(join(REPO, name)) }));

function scripts(packageJson: string): string[] {
  return Object.keys(JSON.parse(read(packageJson)).scripts ?? {});
}

describe('every command the documentation gives can be run', () => {
  /*
   * A reader who has just been told to run something is the least able to work out that
   * the name has moved. `npm run operator:link` is the documented way into a deployment
   * before a mail domain is verified — if that script is ever renamed, the only path in
   * becomes a paragraph pointing at nothing.
   */
  const defined = new Set([
    ...scripts(join(REPO, 'package.json')),
    ...scripts(join(APP, 'package.json')),
  ]);

  it('finds at least one, so a broken scan cannot pass as a clean one', () => {
    const named = docs.flatMap(({ text }) => [...text.matchAll(/npm run ([a-z][a-z:-]*)/g)]);
    expect(named.length).toBeGreaterThan(5);
  });

  for (const { name, text } of docs) {
    const named = [...new Set(
      [...text.matchAll(/npm run ([a-z][a-z:-]*)/g)].map((m) => m[1]!),
    )].sort();
    if (named.length === 0) continue;

    it(`${name} names only scripts that exist`, () => {
      const missing = named.filter((s) => !defined.has(s));
      expect(
        missing,
        `${name} tells the reader to run ${missing.join(', ')}, and no package.json `
        + 'defines it. Either the script was renamed or the instruction was written '
        + 'from memory.',
      ).toEqual([]);
    });
  }
});

describe('every variable the console reads is written down somewhere', () => {
  /*
   * The rule, rather than the instance. A variable the code consults and no template
   * mentions is a setting whose absence is silent — and silence is the whole problem,
   * because a default that looks plausible is worse than a crash. Each exclusion below
   * carries its reason; the list is short on purpose, and a new name belongs in
   * `.env.example` rather than here.
   */
  const NOT_FOR_AN_OPERATOR: Record<string, string> = {
    NODE_ENV: 'set by the framework and the host; writing it into an env file is a way '
      + 'to run a production build in development by accident',
    PGLITE_DIR: "internal: tests/setup.ts points it at memory:// and the app's own "
      + 'fallback owns the on-disk case. An operator never sets it.',
    VERCEL_PROJECT_PRODUCTION_URL: 'injected by the host',
  };

  function envNamesUnder(dirs: string[]): Map<string, string[]> {
    const found = new Map<string, string[]>();
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx|mjs)$/.test(e.name)) {
          for (const m of read(full).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
            const where = found.get(m[1]!) ?? [];
            where.push(full.replace(REPO, ''));
            found.set(m[1]!, where);
          }
        }
      }
    };
    dirs.forEach(walk);
    return found;
  }

  const declared = new Set(
    [...read(join(REPO, '.env.example')).matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
  );

  const used = envNamesUnder([
    join(APP, 'app'), join(APP, 'lib'), join(APP, 'components'), join(REPO, 'scripts'),
  ]);

  it('found the variables at all, so an empty scan cannot pass', () => {
    expect(used.size).toBeGreaterThan(3);
    expect([...used.keys()]).toContain('DATABASE_URL');
    expect(declared.size).toBeGreaterThan(3);
  });

  it('declares every one an operator could need to set', () => {
    const undocumented = [...used.keys()]
      .filter((name) => !declared.has(name) && !(name in NOT_FOR_AN_OPERATOR))
      .sort();

    expect(
      undocumented,
      undocumented.map((n) => `${n} (read by ${used.get(n)!.join(', ')})`).join('; ')
      + ' — read by the console and absent from .env.example. Add it there with what '
      + 'happens when it is unset, or add it to NOT_FOR_AN_OPERATOR above with the '
      + 'reason an operator never sets it.',
    ).toEqual([]);
  });

  it('does not declare variables nothing reads', () => {
    /*
     * The other direction, which is the one that rots quietly: a template still asking
     * for a setting the code stopped consulting teaches an operator that the file is
     * approximate, and then they stop reading it. DIRECT_URL is consulted inside
     * @h-hallows/core's migration config rather than here, so it is expected.
     */
    const READ_ELSEWHERE = new Set(['DIRECT_URL', 'RESEND_API_KEY', 'MAIL_FROM']);
    const stale = [...declared]
      .filter((name) => !used.has(name) && !READ_ELSEWHERE.has(name))
      .sort();
    expect(
      stale,
      `.env.example asks for ${stale.join(', ')} and nothing reads it. Either the code `
      + 'stopped consulting it or it is read in @h-hallows/core — if the latter, say so '
      + 'in READ_ELSEWHERE above.',
    ).toEqual([]);
  });
});

describe('no document offers a log as a place to find a credential', () => {
  /*
   * @h-hallows/core's mail module resolves the console driver to 'none' under
   * NODE_ENV=production precisely so that a sign-in link cannot be recovered from
   * function logs, and the sign-in form refuses everyone identically when no mailer is
   * configured. Two passages in this repository described the opposite.
   *
   * This is a heuristic over prose, which is unusual for a test here, so the trade is
   * worth stating. A false positive costs one qualifying word in a sentence. A false
   * negative is an operator putting a bearer credential into a log drain because the
   * repository's own README told them to. The marker list exists to be added to.
   */
  const LOGS = /\b(function logs|server console)\b/i;
  const CREDENTIAL = /\b(magic link|sign-in link|the link|credential|token)\b/i;
  const QUALIFIED = new RegExp([
    'local', 'locally', 'development', 'dev server', 'used to', 'no longer',
    'instead of', 'alternative', 'never', 'not ', 'nowhere', 'unavailable',
    'refuses', 'cannot', 'does not', 'is false', 'stopped',
  ].join('|'), 'i');

  function sentences(text: string): string[] {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\s*\n\s*/g, ' ')
      .split(/(?<=[.:;!?])\s+/);
  }

  it('is looking at sentences that mention logs, so it can fail', () => {
    const all = docs.flatMap(({ text }) => sentences(text)).filter((s) => LOGS.test(s));
    expect(all.length, 'no document mentions logs at all — the scan found nothing to '
      + 'check, which means it would also find nothing wrong').toBeGreaterThan(0);
  });

  for (const { name, text } of docs) {
    const offers = sentences(text).filter(
      (s) => LOGS.test(s) && CREDENTIAL.test(s) && !QUALIFIED.test(s),
    );
    it(`${name} does not point a reader at the logs for one`, () => {
      expect(
        offers,
        `${name} pairs a credential with the logs and nothing in the sentence says that `
        + 'is only local, or no longer true: "' + offers.join('" / "') + '". In '
        + 'production the console mail driver resolves to none and nothing is printed; '
        + 'the ways in are RESEND_API_KEY + MAIL_FROM, or `npm run operator:link`.',
      ).toEqual([]);
    });
  }
});

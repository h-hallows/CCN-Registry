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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The repository root, two levels above this app. */
const REPO = new URL('../../../', import.meta.url).pathname;
const APP = new URL('../', import.meta.url).pathname;

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * Source with its comments removed, for the scan below.
 *
 * The public site's copy of this rule reported a variable called `NEXT_PUBLIC_`, out of
 * three comments explaining that Next substitutes `process.env.NEXT_PUBLIC_*` where it
 * appears and cannot follow an indexed read. Nothing in this console is written that way
 * today, so this is here before it is needed rather than after: it is the fourth time a
 * source scan in these repositories has read a comment as code, and the pattern is
 * always the same — the comment that explains a rule is written in the vocabulary the
 * rule forbids, and it is the passage most worth keeping.
 *
 * `//` is only taken as a comment when nothing precedes it immediately, so the `//` in a
 * `https://` URL inside a string survives.
 */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A documented path may be relative to the repository root or to the app. */
const ROOTS = [REPO, APP];

const docs = [
  ...readdirSync(REPO).filter((n) => n.endsWith('.md'))
    .map((name) => ({ name, path: join(REPO, name) })),
  /*
   * The pull request template is a document too, and the one every contributor reads.
   * It cited `packages/core/INVARIANTS.md` — the pre-extraction layout — so every pull
   * request opened since carried an invariant checklist pointing at a file that is not
   * there.
   */
  ...readdirSync(join(REPO, '.github')).filter((n) => n.endsWith('.md'))
    .map((name) => ({ name: `.github/${name}`, path: join(REPO, '.github', name) })),
].map(({ name, path }) => ({ name, text: read(path) }));

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
          for (const m of code(full).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
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

describe('every file the documentation names is there', () => {
  /*
   * THE DEFECT THIS RULE IS ABOUT. Step 3 of *Getting a deployment running* said to run
   * `scripts/sql/app-role.sql` in the Supabase SQL editor. That file has never existed.
   * The statements it was meant to hold were in this same README three sections below,
   * under *Connect as a non-owner role*, so the instruction was not wrong about what to
   * do — only about where to find it, which is the kind of wrongness a reader cannot
   * diagnose. An operator standing a deployment up follows step 3, finds nothing, and
   * has no way to know whether the step is obsolete or the file is missing. Skipping it
   * leaves the application connected as the schema owner, and a table owner bypasses
   * row level security on every table.
   *
   * The script-name rule above could not see it: `scripts/sql/app-role.sql` is not an
   * npm script. So the rule is widened from commands to anything the documentation
   * tells a reader to open.
   *
   * WHAT COUNTS AS A PATH. A backticked token containing a slash and ending in a file
   * extension. Directories are excluded deliberately — `app/(marketing)` and
   * `content/statutory` are written as prose nouns throughout and carry parentheses a
   * path matcher would have to special-case. A file is the case that matters: a reader
   * sent to a directory that has moved finds the tree and recovers, while a reader sent
   * to a file that does not exist finds nothing at all.
   */
  const PATH = /`([A-Za-z0-9_./-]+\/[A-Za-z0-9_.-]+\.(?:ts|tsx|sql|mjs|md|css|json|yml))`/g;

  const named = [...new Set(
    docs.flatMap(({ text }) => [...text.matchAll(PATH)].map((m) => m[1]!)),
  )].sort();


  /**
   * A path is checked against THIS repository. A path prefixed with a sibling
   * repository's name is a different claim and is not checked here.
   *
   * WHY NOT RESOLVE THE SIBLINGS. They are separate repositories — on a CI runner only
   * one is checked out, and `@h-hallows/core` arrives as a tarball in `node_modules`
   * with no `tests/` directory at all. A rule that passed locally and could not run in
   * CI would be worse than no rule. So the guarantee is narrower and honest: an
   * UNPREFIXED path must exist here, and a path about a sibling must say which sibling.
   *
   * That second half is worth as much as the first. Ten paths failed this rule when it
   * was written, and only three of them were dead: the rest were real files named
   * without their repository, in a project where `lib/notify.ts` and
   * `tests/clientPortal.test.ts` each exist in a different repository from the document
   * naming them. A reader had no way to tell a moved file from one they were looking for
   * in the wrong tree.
   */
  const SIBLINGS = ['CCN-core/', 'CCN-external/'];
  const SELF = 'CCN-Registry/';

  function resolves(p: string): boolean {
    if (SIBLINGS.some((s) => p.startsWith(s))) return true;
    const local = p.startsWith(SELF) ? p.slice(SELF.length) : p;
    return ROOTS.some((root) => existsSync(join(root, local)));
  }

  it('found paths at all, so an empty scan cannot pass as a clean one', () => {
    expect(named.length).toBeGreaterThan(3);
  });

  it('names only files that exist', () => {
    const missing = named.filter((p) => !resolves(p));
    expect(
      missing,
      `the documentation tells a reader to open ${missing.join(', ')}, and no such file `
      + 'exists. Either it was moved, or it was named from an intention rather than '
      + 'from the tree.',
    ).toEqual([]);
  });
});

describe('the gate that says it checks can actually load', () => {
  /*
   * THE DEFECT THIS RULE IS ABOUT, AND IT IS THE LARGEST ONE IN EITHER REPOSITORY.
   *
   * `.github/workflows/ci.yml` carried the line
   *
   *     run: git config --global url."https://github.com/".insteadOf git@github.com:
   *
   * as a plain scalar. A plain YAML scalar may not end in a colon: the parser reads the
   * trailing `:` as a mapping indicator and stops with "mapping values are not allowed
   * in this context". GitHub could therefore not load the workflow, and a workflow that
   * does not load produces a red run with ZERO jobs and zero check runs — the API even
   * reports its name as its own file path, which is the fallback for one that would not
   * parse. Both repositories had it, at the same column.
   *
   * So every invariant this project describes as enforced in CI had only ever been
   * enforced on a laptop: the copy lint, the brand lint, the typecheck, the suite, the
   * suite again against a real Postgres 16, the build, the one-owner check on
   * migrations. Nothing was wrong with any of those steps. Nothing ran them.
   *
   * WHY THE RULE IS SHAPED THIS WAY. A real parse would be better and needs a YAML
   * dependency neither repository has, for one file. So the hazard is named directly —
   * an unquoted value ending in a colon — along with the gate's own contents, because
   * the second half of this failure is that nobody could tell a workflow that runs
   * nothing from a workflow that is not there. Asserting the step names means emptying
   * the gate fails here instead of going quiet.
   */
  const WORKFLOW = '.github/workflows/ci.yml';
  const workflow = read(join(REPO, WORKFLOW));

  it('has no unquoted value ending in a colon', () => {
    const offenders = workflow
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => {
        const body = line.replace(/\s+$/, '');
        if (body.trimStart().startsWith('#') || !body.endsWith(':')) return false;
        // A key introducing a block is the normal case: `steps:`, `with:`, `- name:`.
        // What cannot stand is a VALUE that ends in one.
        const value = /^\s*(?:-\s*)?[A-Za-z_][\w.-]*:\s+(.*)$/.exec(body)?.[1];
        if (value === undefined || value === '') return false;
        return !(
          (value.startsWith("'") && value.endsWith("':"))
          || (value.startsWith('"') && value.endsWith('":'))
        );
      });
    expect(
      offenders.map((o) => `${WORKFLOW}:${o.n}`),
      offenders.map((o) => o.line.trim()).join(' / ')
      + ' — a plain YAML scalar cannot end in a colon, and GitHub answers by not '
      + 'loading the workflow at all: a red run with no jobs. Use a `|` block scalar.',
    ).toEqual([]);
  });

  it('still runs every gate it is supposed to run', () => {
    for (const job of ['check', 'migrations-have-one-owner']) {
      expect(workflow, `${WORKFLOW} no longer defines the ${job} job`)
        .toContain(`\n  ${job}:`);
    }
    for (const script of ['lint:copy', 'lint:brand', 'typecheck', 'test']) {
      expect(workflow, `${WORKFLOW} no longer runs npm run ${script}`)
        .toMatch(new RegExp(`npm (?:run )?${script.replace(':', ':')}\\b`));
    }
  });
});

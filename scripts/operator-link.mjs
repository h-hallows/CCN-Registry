#!/usr/bin/env node
/**
 * Mint an operator sign-in link, from a machine that can reach the database.
 *
 * WHY THIS EXISTS. The console signs an operator in by emailing a link, and
 * `@h-hallows/core/mail` refuses to print one in production — a magic link is a bearer
 * credential and a log drain is not a place to put it. That is right, and it means a
 * deployment with no mail provider has no way in at all. Wiring Resend needs a verified
 * domain, which needs the trading name, which is with counsel; waiting for a lawyer in
 * order to look at your own software is the wrong shape of problem.
 *
 * So: the same two rows `requestMagicLink` writes, written from a terminal instead. The
 * link is printed HERE, on the machine of whoever ran it, with the connection string
 * they already hold. Nothing about the deployment changes and no new surface exists on
 * it — which is the whole difference between this and a "show me the link" button,
 * which would be an authentication bypass for anybody who could guess an operator's
 * address.
 *
 *   DATABASE_URL=... npm run operator:link -- you@example.com
 *
 * The address must be in OPERATOR_EMAILS, exactly as the login form requires.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const email = (process.argv[2] ?? '').trim().toLowerCase();
const origin = (process.argv[3] ?? process.env.CONSOLE_URL ?? 'http://localhost:3000')
  .replace(/\/+$/, '');

if (!email || !email.includes('@')) {
  console.error('usage: npm run operator:link -- you@example.com [https://console.url]');
  process.exit(2);
}

const permitted = (process.env.OPERATOR_EMAILS ?? '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

if (permitted.length === 0) {
  console.error(
    'OPERATOR_EMAILS is not set. Nobody may sign in without it, and minting a link for\n'
    + 'an address the deployment will not accept would produce a link that fails at the\n'
    + 'last step for no visible reason.',
  );
  process.exit(1);
}
if (!permitted.includes(email)) {
  console.error(`${email} is not in OPERATOR_EMAILS, so the console would refuse it.`);
  process.exit(1);
}

/*
 * Run the insert through core's own client, so this uses the same connection resolution
 * as the application — including the names Vercel injects for a marketplace Postgres.
 *
 * The specifier stays bare. `require.resolve('@h-hallows/core/package.json')` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED, because the package's `exports` map lists its entry
 * points and not its manifest — and hard-coding node_modules/... is the bug
 * core-script.mjs exists to explain. tsx resolves the bare name from the root this
 * runs in, which is where npm hoists it.
 */
const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');

const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');

/*
 * Wrapped in an async function rather than written with top-level await: `tsx --eval`
 * transpiles to CJS, where top-level await is an error.
 */
const program = `
(async () => {
  const { getDb } = await import('@h-hallows/core/db');
  const { query } = await getDb();
  const [user] = await query(
    \`INSERT INTO users (email, display_name, role)
     VALUES ($1, $2, 'operator')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, disabled_at\`,
    [${JSON.stringify(email)}, ${JSON.stringify(email.split('@')[0])}],
  );
  if (!user) { console.error('could not create or find that operator'); process.exit(1); }
  if (user.disabled_at) {
    console.error('That operator is disabled. Clear disabled_at deliberately first.');
    process.exit(1);
  }
  await query(
    \`INSERT INTO auth_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '12 hours')\`,
    [user.id, ${JSON.stringify(tokenHash)}],
  );
})().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
`;

const result = spawnSync(process.execPath, [tsx, '--eval', program], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
});

if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`\nSign-in link for ${email}, good for 12 hours and usable once:\n`);
console.log(`${origin}/login/verify?token=${token}\n`);
console.log('Only the hash is stored. This is the one time the link is readable.');

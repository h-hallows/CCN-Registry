#!/usr/bin/env node
/**
 * Write an advertising_log row for a deploy. § 1812.533(c).
 *
 * A record of every advertisement with its date and publication, kept one year. A
 * website IS an advertisement, and it changes every deploy — so this runs from CI with
 * the commit SHA as the reference. A manual log would not be kept, and an incomplete
 * one is worse than none because it implies the complete ones are reliable.
 *
 *   node scripts/record-advertisement.mjs --publication website --reference <sha>
 */
import { argv, env, exit } from 'node:process';

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const publication = arg('publication', 'website');
const reference = arg('reference', env.VERCEL_GIT_COMMIT_SHA ?? env.GITHUB_SHA ?? 'unknown');
const snapshotUrl = arg('snapshot-url', env.VERCEL_URL ? `https://${env.VERCEL_URL}` : null);
const recordedBy = arg('recorded-by', env.GITHUB_ACTOR ?? 'ci');

const { getDb } = await import('../packages/core/src/db/client.ts');

try {
  const { query, close } = await getDb();
  await query(
    `INSERT INTO advertising_log (published_on, publication, reference, snapshot_url, recorded_by)
     VALUES ((now() AT TIME ZONE 'America/Los_Angeles')::date, $1, $2, $3, $4)`,
    [publication, reference, snapshotUrl, recordedBy],
  );
  console.log(`advertising_log: ${publication} ${reference}`);
  await close();
} catch (err) {
  // Never fail a deploy over the log. A missing row is a gap to backfill; a blocked
  // deploy over bookkeeping is a worse outcome, and the error is loud either way.
  console.error('[advertising-log] could not record this deploy:', err?.message ?? err);
  exit(0);
}

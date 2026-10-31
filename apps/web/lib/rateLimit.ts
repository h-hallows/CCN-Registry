/**
 * Rate limiting for the public intake routes. Spec § 3.
 *
 * Not a CAPTCHA. A bot-filled enquiry costs one operator glance, not money, and a
 * CAPTCHA in front of somebody arranging care for a parent during a discharge is a
 * worse trade than reading a junk form. A limit plus a honeypot plus a timing check is
 * proportionate to what is actually at stake here.
 *
 * Shared state, not a per-process map: every serverless invocation gets its own
 * container, so an in-memory counter would reset constantly and limit nothing.
 */
import { createHash } from 'node:crypto';
import { getDb } from '@ccn/core/db';

export interface RateLimitOptions {
  key: string;
  max: number;
  windowSec: number;
}

/**
 * The caller's identity for limiting purposes, hashed.
 *
 * Hashed because these are people enquiring about care for a parent, and an IP address
 * stored next to "post-surgical, Beverly Hills, discharging Monday" is identifying. A
 * hash counts just as well and is useless for anything else.
 */
function callerHash(request: Request, salt: string): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || request.headers.get('x-real-ip') || 'unknown';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

/** True when the caller has exceeded the limit and the request should be refused. */
export async function rateLimit(
  request: Request,
  { key, max, windowSec }: RateLimitOptions,
): Promise<boolean> {
  const { query } = await getDb();
  const hash = callerHash(request, key);

  try {
    const [row] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rate_limit_hits
        WHERE route = $1 AND key_hash = $2 AND at > now() - ($3 || ' seconds')::interval`,
      [key, hash, String(windowSec)],
    );
    if (Number(row?.n ?? 0) >= max) return true;

    await query(
      `INSERT INTO rate_limit_hits (key_hash, route) VALUES ($1, $2)`, [hash, key],
    );

    // Opportunistic pruning, roughly one request in fifty. A cron for this would be a
    // moving part to maintain for a table nothing reads beyond its own window.
    if (Math.random() < 0.02) {
      await query(`DELETE FROM rate_limit_hits WHERE at < now() - interval '1 day'`);
    }
    return false;
  } catch (err) {
    // A rate limiter that fails closed turns a database blip into a lost discharge
    // enquiry. The downside of failing open is an operator reading a junk form.
    console.error('[rateLimit] could not check, allowing through', err);
    return false;
  }
}

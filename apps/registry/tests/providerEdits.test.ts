import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, TEST_CTX } from '@h-hallows/core/testing';
import { screenCase } from '@/lib/queries/match';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

describe('probe', () => {
  it('describes the fixture', async () => {
    const cases = await db.query<{
      id: string; care: string; status: string; schedule: string[] | null;
      cr_area: string; household: string;
    }>(
      `SELECT c.id::text AS id, c.care::text AS care, c.status::text AS status,
              c.schedule, h.cr_area, h.display_name AS household
         FROM cases c JOIN households h ON h.id = c.household_id
        WHERE c.deleted_at IS NULL ORDER BY c.created_at`,
    );
    const lines: string[] = [];
    for (const k of cases) {
      const screen = await screenCase(db, k.id);
      lines.push(`${k.household} | ${k.care} | ${k.status} | area=${k.cr_area} | sched=${(k.schedule ?? []).length} | eligible=${screen?.eligible.length} | excl=${screen?.excluded.length}`);
      if ((screen?.eligible.length ?? 0) === 0) {
        for (const e of screen?.excluded ?? []) {
          lines.push(`    - ${e.fullName} (${e.type}): ${e.exclusion.code} :: ${e.exclusion.detail}`);
        }
      }
    }
    const providers = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM providers`);
    lines.push(`providers=${providers[0]!.n}`);

    const standing = await db.query<{ household: string; provider: string; how: string }>(
      `SELECT h.display_name AS household, p.full_name AS provider, 'primary' AS how
         FROM cases c JOIN households h ON h.id = c.household_id
         JOIN providers p ON p.id = c.primary_provider_id
        WHERE c.deleted_at IS NULL AND c.status <> 'ended'
       UNION ALL
       SELECT h.display_name, p.full_name, 'referral:' || coalesce(r.outcome::text, 'open')
         FROM referrals r JOIN cases c ON c.id = r.case_id
         JOIN households h ON h.id = c.household_id
         JOIN providers p ON p.id = r.provider_id
        WHERE c.deleted_at IS NULL AND c.status <> 'ended'
       UNION ALL
       SELECT h.display_name, p.full_name, 'alternate'
         FROM cases c JOIN households h ON h.id = c.household_id
         JOIN LATERAL unnest(c.alternate_provider_ids) a(id) ON TRUE
         JOIN providers p ON p.id = a.id
        WHERE c.deleted_at IS NULL AND c.status <> 'ended'`,
    );
    for (const s of standing) lines.push(`STANDING ${s.household} <- ${s.provider} (${s.how})`);

    console.log(lines.join('\n'));
    expect(true).toBe(true);
  });
});

/**
 * Attaching a referral that arrived from the public form.
 *
 * A signed-in partner's referral is attributed as it arrives. One sent by somebody with
 * no account is not, and must not be: the email on that form is typed by whoever filled
 * it in, and `inquiries.partner_id` is what decides who may read the outcome later.
 * Matching on it automatically would let anybody claim another partner's referrals by
 * knowing their address — so the match is offered and an operator decides.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  attachReferralToPartner, listPartners, PartnerError, partnerPopulation,
  unattributedReferrals,
} from '@/lib/queries/partners';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

/** What the public /refer form writes: a partner block, and no partner_id. */
async function publicReferral(email: string | null, name = 'A Sender'): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO inquiries (name, phone, relationship, source_path, referrer)
     VALUES ('Ruth Keating', '(626) 555-7788', 'professional', '/refer', $1::jsonb)
     RETURNING id`,
    [JSON.stringify({
      partnerName: name,
      partnerOrg: 'Somewhere General',
      partnerEmail: email,
      patientInitials: 'R.K.',
      consentConfirmed: true,
    })],
  );
  return row.id;
}

describe('what is waiting to be attached', () => {
  it('lists a referral nobody owns, with what the sender claimed', async () => {
    const id = await publicReferral('nobody-on-the-list@example.com', 'Unknown Sender');

    const waiting = await unattributedReferrals(TEST_CTX);
    const mine = waiting.find((r) => r.inquiryId === id);
    expect(mine).toBeTruthy();
    expect(mine!.claimedName).toBe('Unknown Sender');
    expect(mine!.patientInitials).toBe('R.K.');
    // Nothing on the list has that address, so nothing is suggested.
    expect(mine!.suggestedPartnerId).toBeNull();
  });

  it('suggests a partner whose recorded email is identical, and only suggests', async () => {
    const partner = await one<{ id: string; name: string; email: string }>(
      `SELECT id, name, email FROM referral_partners WHERE email IS NOT NULL
        ORDER BY name LIMIT 1`);
    // Typed in a different case, as somebody would.
    const id = await publicReferral(partner.email.toUpperCase());

    const mine = (await unattributedReferrals(TEST_CTX))
      .find((r) => r.inquiryId === id);
    expect(mine!.suggestedPartnerId).toBe(partner.id);
    expect(mine!.suggestedPartnerName).toBe(partner.name);

    // Suggested, not applied. Until an operator says so it belongs to nobody.
    const row = await one<{ partner_id: string | null }>(
      `SELECT partner_id FROM inquiries WHERE id = $1`, [id]);
    expect(row.partner_id).toBeNull();
  });

  it('drops off the list once attached', async () => {
    const partner = await one<{ id: string }>(
      `SELECT id FROM referral_partners ORDER BY name LIMIT 1`);
    const id = await publicReferral('anyone@example.com');

    await attachReferralToPartner(TEST_CTX, id, partner.id);

    expect((await unattributedReferrals(TEST_CTX)).some((r) => r.inquiryId === id))
      .toBe(false);
    const row = await one<{ partner_id: string | null }>(
      `SELECT partner_id FROM inquiries WHERE id = $1`, [id]);
    expect(row.partner_id).toBe(partner.id);
  });
});

describe('attaching one', () => {
  it('records who decided, and what it grants', async () => {
    const partner = await one<{ id: string; name: string }>(
      `SELECT id, name FROM referral_partners ORDER BY name LIMIT 1`);
    const id = await publicReferral('audit@example.com');

    const result = await attachReferralToPartner(TEST_CTX, id, partner.id);
    expect(result.partnerName).toBe(partner.name);

    const log = await one<{ diff: unknown }>(
      `SELECT diff FROM audit_log
        WHERE entity = 'inquiry' AND entity_id = $1 ORDER BY at DESC LIMIT 1`, [id]);
    const diff = JSON.stringify(log.diff);
    expect(diff).toContain(partner.id);
    // The consequence is written down rather than left to be inferred later.
    expect(diff).toContain('outcome');
  });

  it('is set once', async () => {
    const [first, second] = await db.query<{ id: string }>(
      `SELECT id FROM referral_partners ORDER BY name LIMIT 2`);
    const id = await publicReferral('once@example.com');

    await attachReferralToPartner(TEST_CTX, id, first!.id);
    await expect(attachReferralToPartner(TEST_CTX, id, second!.id))
      .rejects.toThrow(/already attached/);

    const row = await one<{ partner_id: string }>(
      `SELECT partner_id FROM inquiries WHERE id = $1`, [id]);
    expect(row.partner_id).toBe(first!.id);
  });

  it('refuses a partner that does not exist, and a referral that does not', async () => {
    const partner = await one<{ id: string }>(
      `SELECT id FROM referral_partners ORDER BY name LIMIT 1`);
    const id = await publicReferral('missing@example.com');
    const nowhere = '00000000-0000-0000-0000-000000000000';

    await expect(attachReferralToPartner(TEST_CTX, id, nowhere))
      .rejects.toThrow(PartnerError);
    await expect(attachReferralToPartner(TEST_CTX, nowhere, partner.id))
      .rejects.toThrow(PartnerError);

    // The failed attempt left it unattached rather than half-attached.
    const row = await one<{ partner_id: string | null }>(
      `SELECT partner_id FROM inquiries WHERE id = $1`, [id]);
    expect(row.partner_id).toBeNull();
  });

  it('counts against that partner once it is theirs', async () => {
    const partner = await one<{ id: string }>(
      `SELECT id FROM referral_partners ORDER BY name LIMIT 1`);
    const before = (await listPartners(TEST_CTX)).find((p) => p.id === partner.id)!.sent;

    await attachReferralToPartner(TEST_CTX, await publicReferral('counts@example.com'),
      partner.id);

    const after = (await listPartners(TEST_CTX)).find((p) => p.id === partner.id)!.sent;
    expect(after).toBe(before + 1);
  });
});

/**
 * ONE PARTNER POPULATION, REPORTED THE SAME EVERYWHERE.
 *
 * The defect these assertions exist for: /partners said no family had been sent by
 * anybody while /measure showed three rows whose source labels began "Partner", and an
 * operator compared the two. Neither screen was lying about its own query. The partner
 * screen counted `inquiries.partner_id` and nothing else, and the attribution these
 * families actually carry is on `households.partner_id` — the copy `convertInquiry`
 * writes, which outlives the enquiry leaving the queue. One fact, two columns, one of
 * them read.
 *
 * So what is asserted here is not that two figures are equal. It is that there is ONE
 * definition of the partner population, that it is counted from the records rather than
 * from either screen's arithmetic, and that no screen may compute its own — stated over
 * the screens generally, so the fourth one to show this number is covered before it is
 * written.
 */
describe('one partner population', () => {
  /** A partner the household records credit with families no enquiry accounts for. */
  async function partnerAttributedOnlyOnHouseholds() {
    const row = await one<{ partner_id: string; n: string }>(
      `SELECT h.partner_id, count(*)::text AS n
         FROM households h
         LEFT JOIN inquiries i
           ON i.household_id = h.id AND i.partner_id = h.partner_id
        WHERE h.partner_id IS NOT NULL AND h.deleted_at IS NULL AND i.id IS NULL
        GROUP BY h.partner_id
        ORDER BY count(*) DESC
        LIMIT 1`,
    );
    return { id: row.partner_id, households: Number(row.n) };
  }

  it('counts a family whose attribution is only on the household record', async () => {
    /*
     * The regression itself. This partner's card read zero, on the one screen that owns
     * referral partners, while three households on the books named them.
     */
    const partner = await partnerAttributedOnlyOnHouseholds();
    expect(
      partner.households,
      'no household is attributed to a partner without an enquiry behind it, so this '
      + 'test cannot distinguish the fixed query from the broken one',
    ).toBeGreaterThan(0);

    const card = (await listPartners(TEST_CTX)).find((p) => p.id === partner.id);
    expect(card, 'the attributed partner is missing from the list').toBeTruthy();
    expect(card!.sent).toBeGreaterThanOrEqual(partner.households);
    expect(card!.became).toBeGreaterThanOrEqual(partner.households);
  });

  it('counts the figure from the records, not from either screen', async () => {
    /*
     * The independent count, written in a different shape on purpose. Taking it from
     * `listPartners` and comparing it with itself would always reconcile, because it
     * would be made out of the thing it reconciles.
     */
    const counted = await one<{ n: string; became: string }>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE on_books)::text AS became
         FROM (
           SELECT h.id::text AS family, true AS on_books
             FROM households h
            WHERE h.partner_id IS NOT NULL AND h.deleted_at IS NULL
           UNION
           SELECT coalesce(hh.id::text, 'inquiry:' || i.id::text),
                  (hh.id IS NOT NULL)
             FROM inquiries i
             LEFT JOIN households hh
               ON hh.id = i.household_id AND hh.deleted_at IS NULL
            WHERE i.partner_id IS NOT NULL
         ) family`,
    );

    const pop = await partnerPopulation();
    expect(pop.referrals, 'the seed attributes nothing to a partner').toBeGreaterThan(0);
    expect(pop.referrals).toBe(Number(counted.n));
    expect(pop.became).toBe(Number(counted.became));

    const roster = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM referral_partners`);
    expect(pop.partners).toBe(Number(roster.n));
  });

  it('reports one population on every screen that reports a partner count', async () => {
    /*
     * /partners sums its own rows for its header and /measure calls
     * `partnerPopulation()` for its tiles. Those two paths must land on the same three
     * numbers, or the screens disagree again by a different route.
     */
    const pop = await partnerPopulation();
    const rows = await listPartners(TEST_CTX);

    expect(rows.length).toBe(pop.partners);
    expect(rows.reduce((n, r) => n + r.sent, 0)).toBe(pop.referrals);
    expect(rows.reduce((n, r) => n + r.became, 0)).toBe(pop.became);
  });

  it('counts a family once when the enquiry and the household name the same partner', async () => {
    /*
     * The failure mode of the obvious fix. Counting both columns and adding them doubles
     * every referral that converted — which would have made /partners read six where
     * /measure read three, and looked like progress.
     */
    const attributed = await one<{ household_id: string; partner_id: string }>(
      `SELECT h.id AS household_id, h.partner_id
         FROM households h
        WHERE h.partner_id IS NOT NULL AND h.deleted_at IS NULL
        LIMIT 1`,
    );
    const before = await partnerPopulation();

    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO inquiries (name, source_path, partner_id, household_id)
         VALUES ('Already Converted', '/refer', $1, $2)`,
        [attributed.partner_id, attributed.household_id],
      );
      const both = await partnerPopulation();
      expect(both.referrals).toBe(before.referrals);
      expect(both.became).toBe(before.became);

      // And a second family, recorded only as an enquiry, is one more and not two.
      await db.query(
        `INSERT INTO inquiries (name, source_path, partner_id)
         VALUES ('Not Yet Converted', '/refer', $1)`,
        [attributed.partner_id],
      );
      const andOneMore = await partnerPopulation();
      expect(andOneMore.referrals).toBe(before.referrals + 1);
      // Sent, but not on the books: there is no household behind it yet.
      expect(andOneMore.became).toBe(before.became);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('applies deleted_at to both legs rather than to one', async () => {
    /*
     * A predicate on one leg of the union and not the other is how two counts of one
     * fact drift apart without anybody editing a definition. The seed soft-deletes no
     * attributed household, so without this the predicate could be deleted outright with
     * every other test still green.
     */
    const attributed = await one<{ household_id: string; partner_id: string }>(
      `SELECT h.id AS household_id, h.partner_id
         FROM households h
         LEFT JOIN inquiries i ON i.household_id = h.id
        WHERE h.partner_id IS NOT NULL AND h.deleted_at IS NULL AND i.id IS NULL
        LIMIT 1`,
    );
    const before = await partnerPopulation();

    await db.query('BEGIN');
    try {
      await db.query(
        `UPDATE households SET deleted_at = now() WHERE id = $1`,
        [attributed.household_id],
      );
      const deleted = await partnerPopulation();
      expect(deleted.referrals).toBe(before.referrals - 1);
      expect(deleted.became).toBe(before.became - 1);

      /*
       * Now give that soft-deleted household the enquiry it never had. The family is a
       * family the partner sent — so it is counted again — but it is not a household on
       * the books, which is what `became` has to say. If the other leg ignored
       * `deleted_at`, this would read as on the books.
       */
      await db.query(
        `INSERT INTO inquiries (name, source_path, partner_id, household_id)
         VALUES ('Sent, Then Deleted', '/refer', $1, $2)`,
        [attributed.partner_id, attributed.household_id],
      );
      const withEnquiry = await partnerPopulation();
      expect(withEnquiry.referrals).toBe(before.referrals);
      expect(withEnquiry.became).toBe(before.became - 1);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('dates a partner last-sent in California, not in UTC', async () => {
    /*
     * This column renders through shortDate(), which reads the leading YYYY-MM-DD off
     * the string. Cast from a timestamptz it was UTC, so from late afternoon Pacific a
     * partner who sent a family this evening was dated tomorrow — on the screen whose
     * job is to show whether a partner has gone quiet. It was invisible because the seed
     * writes no enquiries, so the column was null on every row.
     */
    const quiet = (await listPartners(TEST_CTX)).find((p) => p.lastSentAt === null);
    expect(quiet, 'every partner in the seed has sent something').toBeTruthy();

    await db.query('BEGIN');
    try {
      // 23:30 Pacific on 15 June is 06:30 UTC on the 16th. The civil date is the 15th.
      await db.query(
        `INSERT INTO inquiries (name, source_path, partner_id, received_at)
         VALUES ('Late Evening', '/refer', $1, '2026-06-15 23:30:00-07'::timestamptz)`,
        [quiet!.id],
      );
      const card = (await listPartners(TEST_CTX)).find((p) => p.id === quiet!.id)!;
      expect(card.lastSentAt).toBe('2026-06-15');
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('leaves the partner population to the one module that owns it', () => {
    /*
     * THE RULE, not the instance.
     *
     * Every assertion above would still pass if a fourth screen were added tomorrow with
     * its own SELECT over `referral_partners` — and that is precisely how the third one
     * came to disagree with the second. So: the definition lives in
     * lib/queries/partners.ts, and no other file under app/ or lib/ may select over the
     * partner table or filter on the attribution key. A screen that needs the figure
     * imports `partnerPopulation`; there is no second way to get it.
     *
     * tests/ is deliberately outside the scan. The independent count above is supposed
     * to be a second opinion written in different SQL, which is the one place a second
     * copy is the point rather than the defect.
     */
    const root = join(import.meta.dirname, '..');
    const owner = join(root, 'lib/queries/partners.ts');

    function sources(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sources(path, out);
        else if (/\.tsx?$/.test(entry)) out.push(path);
      }
      return out;
    }

    // The scan has to be able to see the owning module, or it proves nothing.
    expect(readFileSync(owner, 'utf8')).toMatch(/FROM referral_partners/);

    const offenders = sources(join(root, 'lib'))
      .concat(sources(join(root, 'app')))
      .filter((path) => path !== owner)
      .filter((path) => {
        const text = readFileSync(path, 'utf8');
        return /FROM\s+referral_partners/i.test(text)
          || /partner_id\s+IS\s+NOT\s+NULL/i.test(text);
      })
      .map((path) => path.slice(root.length + 1));

    expect(
      offenders,
      'these compute a partner figure of their own instead of importing '
      + 'partnerPopulation from lib/queries/partners.ts: ' + offenders.join(', '),
    ).toEqual([]);
  });
});

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
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  attachReferralToPartner, listPartners, PartnerError, unattributedReferrals,
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

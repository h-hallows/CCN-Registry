/**
 * The front door, from the operator's side.
 *
 * Until this existed the three public intake routes wrote to `inquiries` and nothing in
 * this console read it — Today's "needs response" bucket reads `cases`, which is a step
 * later — and nothing anywhere created a `households` or `cases` row. Every household
 * in the system came from the seed, and a family who filled in the form arrived in a
 * table nobody displayed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  convertInquiry, countUnhandledInquiries, IntakeError, recentlyHandled,
  turnAwayInquiry, unhandledInquiries,
} from '@/lib/queries/intake';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

/** What the public form writes. */
async function arrive(over: Record<string, unknown> = {}): Promise<string> {
  const row = {
    name: 'Ruth Keating', phone: '(626) 555-7788', email: 'ruth@example.com',
    relationship: 'Daughter', care_type: 'personal_care', area: 'Pasadena',
    urgency: 'routine', payment_method: 'private',
    message: 'Mum is managing but not quite.', source_path: '/',
    ...over,
  };
  const inserted = await one<{ id: string }>(
    `INSERT INTO inquiries
       (name, phone, email, relationship, care_type, area, urgency, payment_method,
        message, source_path)
     VALUES ($1,$2,$3,$4,$5::care_type,$6,$7::urgency,$8::payment_method,$9,$10)
     RETURNING id`,
    [row.name, row.phone, row.email, row.relationship, row.care_type, row.area,
      row.urgency, row.payment_method, row.message, row.source_path],
  );
  return inserted.id;
}

const CONVERT = {
  displayName: 'Keating — Pasadena',
  dmName: 'Ruth Keating',
  crArea: 'Pasadena',
  care: 'personal_care' as const,
  urgency: 'routine' as const,
  paymentMethod: 'private' as const,
};

describe('seeing what arrived', () => {
  it('shows an unanswered enquiry, with what the family typed', async () => {
    const id = await arrive({ message: 'Nobody local to notice.' });

    const waiting = await unhandledInquiries(TEST_CTX);
    const mine = waiting.find((q) => q.id === id);
    expect(mine).toBeTruthy();
    expect(mine!.message).toBe('Nobody local to notice.');
    expect(mine!.handledAt).toBeNull();
    expect(await countUnhandledInquiries()).toBeGreaterThanOrEqual(1);
  });

  it('puts a discharge above a routine enquiry that arrived first', async () => {
    // Ordered in SQL, so the badge and the list cannot disagree about what is waiting.
    const routine = await arrive({ urgency: 'routine' });
    const discharge = await arrive({ urgency: 'discharge' });

    const ids = (await unhandledInquiries(TEST_CTX)).map((q) => q.id);
    expect(ids.indexOf(discharge)).toBeLessThan(ids.indexOf(routine));
  });
});

describe('opening one as a case', () => {
  it('creates the household and its first case, and joins them to the enquiry', async () => {
    const id = await arrive();
    const households = async () => Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM households`))[0]!.n);
    const before = await households();

    const result = await convertInquiry(TEST_CTX, { inquiryId: id, ...CONVERT });

    expect(await households()).toBe(before + 1);

    const kase = await one<{
      household_id: string; status: string; care: string; needs_authored_by: string;
    }>(
      `SELECT household_id, status::text AS status, care::text AS care, needs_authored_by
         FROM cases WHERE id = $1`, [result.caseId]);
    expect(kase.household_id).toBe(result.householdId);
    expect(kase.status).toBe('inquiry');
    expect(kase.care).toBe('personal_care');
    // I10: what they need is theirs, never the registry's.
    expect(kase.needs_authored_by).toBe('household');

    const inquiry = await one<{ household_id: string; handled_by: string }>(
      `SELECT household_id, handled_by FROM inquiries WHERE id = $1`, [id]);
    expect(inquiry.household_id).toBe(result.householdId);
    expect(inquiry.handled_by).toBe(TEST_CTX.actor);
  });

  it('leaves what the family typed exactly as they typed it', async () => {
    /*
     * The enquiry is the record of what was asked for; the household is what the
     * registry believes after a conversation. They differ often — a family asks for a
     * nurse and needs a caregiver — and "what did they originally say" has to stay
     * answerable.
     */
    const id = await arrive({ care_type: 'skilled_nursing', message: 'We need a nurse.' });

    await convertInquiry(TEST_CTX, {
      inquiryId: id, ...CONVERT, care: 'personal_care',
    });

    const inquiry = await one<{ care_type: string; message: string }>(
      `SELECT care_type::text AS care_type, message FROM inquiries WHERE id = $1`, [id]);
    expect(inquiry.care_type).toBe('skilled_nursing');
    expect(inquiry.message).toBe('We need a nurse.');
  });

  it('writes a timeline entry that says where the case came from', async () => {
    const id = await arrive({ message: 'Discharging Friday.' });
    const result = await convertInquiry(TEST_CTX, { inquiryId: id, ...CONVERT });

    const entry = await one<{ type: string; body: string }>(
      `SELECT type::text AS type, body FROM timeline_entries
        WHERE case_id = $1 ORDER BY at LIMIT 1`, [result.caseId]);
    expect(entry.type).toBe('inquiry');
    expect(entry.body).toContain('Discharging Friday.');
  });

  it('counts it, so the funnel has a first step', async () => {
    const id = await arrive();
    const result = await convertInquiry(TEST_CTX, { inquiryId: id, ...CONVERT });

    const event = await one<{ event: string }>(
      `SELECT event::text AS event FROM metric_events
        WHERE case_id = $1 ORDER BY at DESC LIMIT 1`, [result.caseId]);
    expect(event.event).toBe('inquiry_received');
  });

  it('refuses one somebody already dealt with, and says who', async () => {
    const id = await arrive();
    await convertInquiry(TEST_CTX, { inquiryId: id, ...CONVERT });

    await expect(convertInquiry(TEST_CTX, { inquiryId: id, ...CONVERT }))
      .rejects.toThrow(/already dealt with/);
  });

  it('creates nothing at all when the form is short of what a household needs', async () => {
    const id = await arrive();
    const households = async () => Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM households`))[0]!.n);
    const before = await households();

    await expect(convertInquiry(TEST_CTX, { inquiryId: id, ...CONVERT, dmName: ' ' }))
      .rejects.toThrow(IntakeError);
    await expect(convertInquiry(TEST_CTX, { inquiryId: id, ...CONVERT, crArea: '' }))
      .rejects.toThrow(IntakeError);

    expect(await households()).toBe(before);
    // And it is still waiting, rather than out of the queue with nothing behind it.
    const still = await one<{ handled_at: string | null }>(
      `SELECT handled_at::text FROM inquiries WHERE id = $1`, [id]);
    expect(still.handled_at).toBeNull();
  });

  it('refuses an enquiry that does not exist', async () => {
    await expect(convertInquiry(TEST_CTX, {
      inquiryId: '00000000-0000-0000-0000-000000000000', ...CONVERT,
    })).rejects.toThrow(/does not exist/);
  });
});

describe('turning one away', () => {
  it('records the reason and counts it, rather than deleting it', async () => {
    const id = await arrive();

    await expect(turnAwayInquiry(TEST_CTX, id, ' ')).rejects.toThrow(/why/i);
    await turnAwayInquiry(TEST_CTX, id, 'Outside the area we cover.');

    const row = await one<{ handled_at: string; household_id: string | null }>(
      `SELECT handled_at::text, household_id FROM inquiries WHERE id = $1`, [id]);
    expect(row.handled_at).not.toBeNull();
    // Turned away is not converted. The difference is what makes the count mean
    // something: DEFERRED.md puts turn-aways in the baseline.
    expect(row.household_id).toBeNull();

    const log = await one<{ diff: unknown }>(
      `SELECT diff FROM audit_log WHERE entity = 'inquiry' AND entity_id = $1
        ORDER BY at DESC LIMIT 1`, [id]);
    expect(JSON.stringify(log.diff)).toContain('Outside the area');

    expect((await unhandledInquiries(TEST_CTX)).some((q) => q.id === id)).toBe(false);
    expect((await recentlyHandled(TEST_CTX)).some((q) => q.id === id)).toBe(true);
  });

  it('refuses one that is already converted', async () => {
    const id = await arrive();
    await convertInquiry(TEST_CTX, { inquiryId: id, ...CONVERT });
    await expect(turnAwayInquiry(TEST_CTX, id, 'changed my mind'))
      .rejects.toThrow(/already dealt with/);
  });
});

/**
 * The posted fee schedule. Civil Code § 1812.527.
 *
 * The provider portal read `fee_schedules` and `fee_schedule_deliveries`; nothing
 * anywhere wrote either, so neither of the statute's two obligations — post a
 * schedule, give it to a nurse before the interview — could be met by the software,
 * and /pro/fee-schedule was permanently empty for every RN and LVN on the roster.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, TEST_CTX } from '@h-hallows/core/testing';
import { addDays, civilLA, formatISODate } from '@h-hallows/core/domain';
import {
  earliestEffectiveFrom, EMBARGO_DAYS, feeScheduleHistory, FeeScheduleError,
  nurseDeliveries, postFeeSchedule, recordFeeScheduleDelivery,
} from '@/lib/queries/feeSchedule';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

const BODY =
  'The registry charges a single fee covering all charges, invoiced monthly in '
  + 'arrears. The provider sets their own hourly rate and is paid by the household.';

const inDays = (n: number) => formatISODate(addDays(civilLA(new Date()), n));

describe('posting one', () => {
  it('records it, numbers it, and counts the notice', async () => {
    const result = await postFeeSchedule(TEST_CTX, {
      maxFeePct: 18,
      paymentTerms: 'Net 15',
      body: BODY,
      effectiveFrom: inDays(10),
    });

    const history = await feeScheduleHistory(TEST_CTX);
    const mine = history.find((s) => s.id === result.id);
    expect(mine!.version).toBe(result.version);
    expect(mine!.maxFeePct).toBe('18.00');
    expect(mine!.upcoming).toBe(true);
    expect(mine!.inForce).toBe(false);

    const log = await one<{ diff: unknown }>(
      `SELECT diff FROM audit_log WHERE entity = 'fee_schedule' AND entity_id = $1`,
      [result.id]);
    // The gap is what the statute is about, so it is written down rather than derived.
    expect(JSON.stringify(log.diff)).toContain('"noticeDays":10');
  });

  it('refuses less than seven days, with the earliest date that would work', async () => {
    /*
     * The database refuses it too — `fee_schedule_seven_day_embargo` — and that is
     * what makes the rule real. What this adds is a message naming the date, because
     * a CHECK violation on a compliance screen says something went wrong and not what.
     */
    await expect(postFeeSchedule(TEST_CTX, {
      maxFeePct: 18, paymentTerms: 'Net 15', body: BODY, effectiveFrom: inDays(3),
    })).rejects.toThrow(new RegExp(earliestEffectiveFrom()));

    // And the constraint catches it if this function ever stops.
    await expect(db.query(
      `INSERT INTO fee_schedules (version, max_fee_pct, payment_terms, body,
                                  posted_at, effective_from)
       VALUES (9100, 18, 'Net 15', $1, now(), (now() + interval '3 days')::date)`,
      [BODY],
    )).rejects.toThrow(/seven_day_embargo|violates check/i);
  });

  it('accepts exactly seven days, which is what the statute asks for', async () => {
    const result = await postFeeSchedule(TEST_CTX, {
      maxFeePct: 20, paymentTerms: 'Net 30', body: BODY,
      effectiveFrom: inDays(EMBARGO_DAYS),
    });
    expect(result.version).toBeGreaterThan(0);
  });

  it('refuses a fee that is not a percentage, and a body that is a fragment', async () => {
    const base = {
      maxFeePct: 18, paymentTerms: 'Net 15', body: BODY, effectiveFrom: inDays(10),
    };
    await expect(postFeeSchedule(TEST_CTX, { ...base, maxFeePct: 0 }))
      .rejects.toThrow(FeeScheduleError);
    await expect(postFeeSchedule(TEST_CTX, { ...base, maxFeePct: 140 }))
      .rejects.toThrow(FeeScheduleError);
    await expect(postFeeSchedule(TEST_CTX, { ...base, body: 'See attached.' }))
      .rejects.toThrow(FeeScheduleError);
  });

  it('never edits a version — it supersedes it', async () => {
    const posted = await postFeeSchedule(TEST_CTX, {
      maxFeePct: 15, paymentTerms: 'Net 15', body: BODY, effectiveFrom: inDays(8),
    });
    await expect(db.query(
      `UPDATE fee_schedules SET max_fee_pct = 40 WHERE id = $1`, [posted.id],
    )).rejects.toThrow();
  });
});

describe('who has been given it', () => {
  async function aNurse(): Promise<{ id: string; full_name: string }> {
    return one<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM providers
        WHERE type IN ('RN','LVN') AND deleted_at IS NULL ORDER BY id LIMIT 1`);
  }

  it('lists every nurse and whether they have the version in force', async () => {
    const rows = await nurseDeliveries(TEST_CTX);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(['RN', 'LVN']).toContain(row.type);
  });

  it('records a delivery, and says whether it was before the interview', async () => {
    const nurse = await aNurse();
    const schedule = await postFeeSchedule(TEST_CTX, {
      maxFeePct: 18, paymentTerms: 'Net 15', body: BODY, effectiveFrom: inDays(9),
    });

    await recordFeeScheduleDelivery(TEST_CTX, {
      providerId: nurse.id,
      scheduleId: schedule.id,
      deliveredOn: formatISODate(civilLA(new Date())),
      beforeInterview: true,
    });

    const row = await one<{ before_interview: boolean; delivered_by: string }>(
      `SELECT before_interview, delivered_by FROM fee_schedule_deliveries
        WHERE provider_id = $1 AND schedule_id = $2`, [nurse.id, schedule.id]);
    expect(row.before_interview).toBe(true);
    expect(row.delivered_by).toBe(TEST_CTX.actor);
  });

  it('records one that was NOT before the interview, rather than refusing it', async () => {
    /*
     * A form that only accepts the compliant answer produces a clean record of
     * something that did not happen. § 1812.527 says before the interview; a delivery
     * recorded as after is the evidence of a gap, and worth having.
     */
    const nurse = await aNurse();
    const schedule = await postFeeSchedule(TEST_CTX, {
      maxFeePct: 18, paymentTerms: 'Net 15', body: BODY, effectiveFrom: inDays(11),
    });

    await recordFeeScheduleDelivery(TEST_CTX, {
      providerId: nurse.id, scheduleId: schedule.id,
      deliveredOn: formatISODate(civilLA(new Date())), beforeInterview: false,
    });

    const row = await one<{ before_interview: boolean }>(
      `SELECT before_interview FROM fee_schedule_deliveries
        WHERE provider_id = $1 AND schedule_id = $2`, [nurse.id, schedule.id]);
    expect(row.before_interview).toBe(false);
  });

  it('refuses a second record of the same version to the same nurse', async () => {
    const nurse = await aNurse();
    const schedule = await postFeeSchedule(TEST_CTX, {
      maxFeePct: 18, paymentTerms: 'Net 15', body: BODY, effectiveFrom: inDays(12),
    });
    const args = {
      providerId: nurse.id, scheduleId: schedule.id,
      deliveredOn: formatISODate(civilLA(new Date())), beforeInterview: true,
    };
    await recordFeeScheduleDelivery(TEST_CTX, args);
    await expect(recordFeeScheduleDelivery(TEST_CTX, args))
      .rejects.toThrow(/already recorded/);
  });

  it('refuses somebody the statute does not cover', async () => {
    const other = await one<{ id: string; type: string }>(
      `SELECT id, type::text AS type FROM providers
        WHERE type NOT IN ('RN','LVN') AND deleted_at IS NULL ORDER BY id LIMIT 1`);
    const schedule = await postFeeSchedule(TEST_CTX, {
      maxFeePct: 18, paymentTerms: 'Net 15', body: BODY, effectiveFrom: inDays(13),
    });

    await expect(recordFeeScheduleDelivery(TEST_CTX, {
      providerId: other.id, scheduleId: schedule.id,
      deliveredOn: formatISODate(civilLA(new Date())), beforeInterview: true,
    })).rejects.toThrow(/covers nurses/);
  });
});

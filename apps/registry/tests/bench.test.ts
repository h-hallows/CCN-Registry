/**
 * The operator half of the client portal.
 *
 * Publishing is the moment a provider reaches a client, so the tests that matter here are
 * the refusals: an ineligible provider, a provider the household has blocked, an ended
 * case, and — the one the architecture spec calls load-bearing — the fact that nothing in
 * this path creates a referral. Every negative assertion below is constructed so that it
 * would fail if the gate were removed; a test that only observes a seed where the bug
 * cannot occur is the way migration 0008's hole survived a green suite.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { caseIdWhere, expectRejection, seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  BenchError, benchesFor, countPendingRequests, feedbackForCase, pendingRequests,
  publishBench, resolveRequest, withdrawBench,
} from '@/lib/queries/bench';
import { makeReferral, ReferralError } from '@/lib/domain/referral';
import { shortlistFor } from '@/lib/queries/match';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

/** A household user, so a request can name a real `requested_by`. */
async function householdUser(caseId: string): Promise<string> {
  const [hh] = await db.query<{ household_id: string }>(
    `SELECT household_id FROM cases WHERE id = $1`, [caseId],
  );
  const email = `household-${hh!.household_id.slice(0, 8)}@example.com`;
  const [user] = await db.query<{ id: string }>(
    `INSERT INTO users (email, display_name, role) VALUES ($1, 'Household', 'household')
     ON CONFLICT (email) DO UPDATE SET display_name = 'Household'
     RETURNING id`,
    [email],
  );
  await db.query(
    `INSERT INTO household_users (household_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [hh!.household_id, user!.id],
  );
  return user!.id;
}

/** What the household portal does: one pending row, four columns, nothing else. */
async function ask(shortlistId: string, providerId: string, caseId: string): Promise<string> {
  const userId = await householdUser(caseId);
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO shortlist_requests (shortlist_id, provider_id, requested_by, note)
     VALUES ($1, $2, $3, 'Please tell us more.')
     RETURNING id`,
    [shortlistId, providerId, userId],
  );
  return row!.id;
}

interface Workable { caseId: string; eligible: string[] }

/**
 * Cases that can actually carry a bench, widest first.
 *
 * Picked by the number of providers who clear the screen rather than by care type: a
 * seed that happens to have one eligible nurse for the case a test named would make the
 * ordering assertions below vacuous instead of failing.
 */
async function workableCases(): Promise<Workable[]> {
  const rows = await db.query<{ id: string; care: string }>(
    `SELECT id, care::text AS care FROM cases
      WHERE deleted_at IS NULL AND status <> 'ended' ORDER BY id`,
  );
  const out: Workable[] = [];
  for (const row of rows) {
    const shortlist = await shortlistFor(TEST_CTX, row.id);
    // Skilled care needs an ordering physician before it can be referred (I11), and
    // these tests are about the bench, not about that gate.
    if (row.care !== 'companion' && row.care !== 'personal_care' && row.care !== 'respite') {
      continue;
    }
    if (!shortlist || shortlist.eligible.length === 0) continue;
    out.push({ caseId: row.id, eligible: shortlist.eligible.map((e) => e.providerId) });
  }
  out.sort((a, b) => b.eligible.length - a.eligible.length);
  expect(out.length).toBeGreaterThan(1);
  return out;
}

async function anActiveCase(min = 2): Promise<Workable> {
  const found = (await workableCases()).find((c) => c.eligible.length >= min);
  expect(found, `no case with ${min} eligible providers`).toBeTruthy();
  return found!;
}

describe('publishing a bench', () => {
  it('puts the chosen providers in front of the household, in order', async () => {
    const { caseId, eligible } = await anActiveCase();
    const chosen = eligible.slice(0, 2);

    const result = await publishBench(TEST_CTX, {
      caseId, providerIds: chosen, note: 'Two people we would start with.',
    });
    expect(result.count).toBe(chosen.length);

    const benches = await benchesFor(TEST_CTX, caseId);
    const live = benches.find((b) => !b.withdrawnAt);
    expect(live!.shortlistId).toBe(result.shortlistId);
    expect(live!.note).toBe('Two people we would start with.');
    expect(live!.items.map((i) => i.providerId)).toEqual(chosen);
    expect(live!.items.map((i) => i.position)).toEqual([0, 1]);
  });

  it('writes a timeline entry naming who was published', async () => {
    const { caseId, eligible } = await anActiveCase();
    const before = await db.query(
      `SELECT 1 FROM timeline_entries WHERE case_id = $1 AND type = 'shortlist'`, [caseId],
    );
    await publishBench(TEST_CTX, { caseId, providerIds: [eligible[0]!] });
    const after = await db.query<{ body: string }>(
      `SELECT body FROM timeline_entries
        WHERE case_id = $1 AND type = 'shortlist' ORDER BY at DESC`,
      [caseId],
    );
    expect(after.length).toBe(before.length + 1);
    expect(after[0]!.body).toContain('Bench published to the household');
  });

  it('creates no referral and no disclosure — the load-bearing rule', async () => {
    const { caseId, eligible } = await anActiveCase();
    const countOf = async (table: string) => Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE case_id = $1`, [caseId],
    ))[0]!.n);

    const referralsBefore = await countOf('referrals');
    const disclosuresBefore = await countOf('disclosures');

    await publishBench(TEST_CTX, { caseId, providerIds: eligible.slice(0, 2) });

    expect(await countOf('referrals')).toBe(referralsBefore);
    expect(await countOf('disclosures')).toBe(disclosuresBefore);
  });

  it('refuses an ineligible provider, by name and with the reason', async () => {
    const { caseId } = await anActiveCase();
    const shortlist = await shortlistFor(TEST_CTX, caseId);
    const no = shortlist!.excluded[0];
    expect(no).toBeTruthy();

    await expect(
      publishBench(TEST_CTX, { caseId, providerIds: [no!.providerId] }),
    ).rejects.toThrow(BenchError);
    await expect(
      publishBench(TEST_CTX, { caseId, providerIds: [no!.providerId] }),
    ).rejects.toThrow(new RegExp(no!.fullName.split(' ')[0]!));

    // And nothing was written on the way to the refusal.
    const live = (await benchesFor(TEST_CTX, caseId)).find((b) => !b.withdrawnAt);
    expect(live?.items.some((i) => i.providerId === no!.providerId) ?? false).toBe(false);
  });

  it('refuses a provider who lapsed between drawing the list and pressing publish', async () => {
    const { caseId, eligible } = await anActiveCase();
    const target = eligible[0]!;

    // The operator's screen was drawn a minute ago. Now the roster changes.
    await db.query(
      `UPDATE providers SET status = 'do_not_refer' WHERE id = $1`, [target],
    );
    try {
      await expect(
        publishBench(TEST_CTX, { caseId, providerIds: [target] }),
      ).rejects.toThrow(BenchError);
    } finally {
      await db.query(`UPDATE providers SET status = 'active' WHERE id = $1`, [target]);
    }

    // Proof the assertion means something: eligible again, the same call succeeds.
    await publishBench(TEST_CTX, { caseId, providerIds: [target] });
  });

  it('refuses an ended case and an empty selection', async () => {
    const ended = await caseIdWhere(db, `c.status = 'ended'`);
    await expect(publishBench(TEST_CTX, { caseId: ended, providerIds: [] }))
      .rejects.toThrow(/at least one provider/);

    const { eligible } = await anActiveCase();
    await expect(publishBench(TEST_CTX, { caseId: ended, providerIds: [eligible[0]!] }))
      .rejects.toThrow(/ended/);
  });

  it('withdraws the live bench so one case shows one bench', async () => {
    const { caseId, eligible } = await anActiveCase();
    const first = await publishBench(TEST_CTX, { caseId, providerIds: [eligible[0]!] });
    const second = await publishBench(TEST_CTX, { caseId, providerIds: eligible.slice(0, 2) });
    expect(second.replaced).toBeGreaterThanOrEqual(1);

    const benches = await benchesFor(TEST_CTX, caseId);
    expect(benches.filter((b) => !b.withdrawnAt)).toHaveLength(1);
    expect(benches.find((b) => b.shortlistId === first.shortlistId)!.withdrawnAt)
      .not.toBeNull();
  });
});

describe('withdrawing a bench', () => {
  it('needs a reason, happens once, and keeps the requests', async () => {
    const { caseId, eligible } = await anActiveCase();
    const bench = await publishBench(TEST_CTX, { caseId, providerIds: [eligible[0]!] });
    const requestId = await ask(bench.shortlistId, eligible[0]!, caseId);

    await expect(withdrawBench(TEST_CTX, bench.shortlistId, '  '))
      .rejects.toThrow(/why/i);

    await withdrawBench(TEST_CTX, bench.shortlistId, 'The household paused the search.');
    await expect(withdrawBench(TEST_CTX, bench.shortlistId, 'again'))
      .rejects.toThrow(/already withdrawn/);

    const [req] = await db.query<{ status: string }>(
      `SELECT status::text AS status FROM shortlist_requests WHERE id = $1`, [requestId],
    );
    expect(req!.status).toBe('pending');
  });
});

describe('the request queue', () => {
  it('shows what a household asked, oldest first, and counts it', async () => {
    const { caseId, eligible } = await anActiveCase();
    const bench = await publishBench(TEST_CTX, { caseId, providerIds: eligible.slice(0, 2) });
    const requestId = await ask(bench.shortlistId, eligible[0]!, caseId);

    const queue = await pendingRequests(TEST_CTX);
    const mine = queue.find((q) => q.requestId === requestId);
    expect(mine).toBeTruthy();
    expect(mine!.caseId).toBe(caseId);
    expect(mine!.note).toBe('Please tell us more.');
    expect(mine!.dmName.length).toBeGreaterThan(1);
    expect(await countPendingRequests()).toBeGreaterThanOrEqual(1);

    const asked = queue.map((q) => q.requestedAt);
    expect([...asked].sort()).toEqual(asked);
  });

  it('records what the household decided, and cannot reach "referred" doing it', async () => {
    const { caseId, eligible } = await anActiveCase();
    const bench = await publishBench(TEST_CTX, { caseId, providerIds: [eligible[0]!] });
    const requestId = await ask(bench.shortlistId, eligible[0]!, caseId);

    await expect(resolveRequest(TEST_CTX, requestId, 'withdrawn', ' '))
      .rejects.toThrow(/what was said/i);

    await resolveRequest(
      TEST_CTX, requestId, 'declined_by_household', 'They went with a relative for now.',
    );

    const [req] = await db.query<{ status: string; referral_id: string | null }>(
      `SELECT status::text AS status, referral_id FROM shortlist_requests WHERE id = $1`,
      [requestId],
    );
    expect(req!.status).toBe('declined_by_household');
    expect(req!.referral_id).toBeNull();

    await expect(resolveRequest(TEST_CTX, requestId, 'withdrawn', 'changed again'))
      .rejects.toThrow(/already/);
  });

  it('the status the household is shown can only become "referred" with a referral', async () => {
    const { caseId, eligible } = await anActiveCase();
    const bench = await publishBench(TEST_CTX, { caseId, providerIds: [eligible[0]!] });
    const requestId = await ask(bench.shortlistId, eligible[0]!, caseId);

    // The CHECK constraint, not the application, is what makes this impossible.
    await expectRejection(
      () => db.query(
        `UPDATE shortlist_requests SET status = 'referred' WHERE id = $1`, [requestId],
      ),
      /shortlist_request_referred_has_referral|violates check/i,
    );
  });
});

describe('a request becoming a referral', () => {
  it('links the request to the referral it answers, in the same transaction', async () => {
    const { caseId, eligible } = await anActiveCase();
    const providerId = eligible[0]!;
    const bench = await publishBench(TEST_CTX, { caseId, providerIds: [providerId] });
    const requestId = await ask(bench.shortlistId, providerId, caseId);

    const [household] = await db.query<{ dm_name: string }>(
      `SELECT h.dm_name FROM cases c JOIN households h ON h.id = c.household_id
        WHERE c.id = $1`, [caseId],
    );
    const dmName = household!.dm_name;

    const result = await makeReferral(TEST_CTX, {
      caseId,
      providerId,
      disclosedTo: dmName,
      disclosedBy: 'Operator',
      method: 'phone',
      spokenDisclosureGiven: true,
      fromRequestId: requestId,
    });

    const [req] = await db.query<{ status: string; referral_id: string; resolved_at: string }>(
      `SELECT status::text AS status, referral_id, resolved_at::text AS resolved_at
         FROM shortlist_requests WHERE id = $1`,
      [requestId],
    );
    expect(req!.status).toBe('referred');
    expect(req!.referral_id).toBe(result.referralId);
    expect(req!.resolved_at).not.toBeNull();
    expect((await pendingRequests(TEST_CTX)).some((q) => q.requestId === requestId))
      .toBe(false);
  });

  it('refuses a request from another case, and writes no referral', async () => {
    const [first, second] = await workableCases();
    const a = first!.caseId;
    const b = second!.caseId;
    expect(a).not.toBe(b);

    // A provider eligible on BOTH, so the only thing refusing this is the case check.
    const providerId = second!.eligible.find((id) => first!.eligible.includes(id));
    expect(providerId, 'need a provider eligible on two cases').toBeTruthy();
    const bench = await publishBench(TEST_CTX, { caseId: b, providerIds: [providerId!] });
    const requestId = await ask(bench.shortlistId, providerId!, b);

    const countA = async () => Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM referrals WHERE case_id = $1`, [a],
    ))[0]!.n);
    const before = await countA();

    await expect(makeReferral(TEST_CTX, {
      caseId: a,
      providerId: providerId!,
      disclosedTo: 'Someone',
      disclosedBy: 'Operator',
      method: 'phone',
      spokenDisclosureGiven: true,
      fromRequestId: requestId,
    })).rejects.toThrow(ReferralError);

    // The whole transaction rolled back: no referral, and the request is untouched.
    expect(await countA()).toBe(before);
    const [req] = await db.query<{ status: string }>(
      `SELECT status::text AS status FROM shortlist_requests WHERE id = $1`, [requestId],
    );
    expect(req!.status).toBe('pending');
  });

  it('refuses a request about a different provider', async () => {
    const { caseId, eligible } = await anActiveCase();
    const [one, two] = eligible;
    expect(two).toBeTruthy();

    const bench = await publishBench(TEST_CTX, { caseId, providerIds: [one!, two!] });
    const requestId = await ask(bench.shortlistId, one!, caseId);

    await expect(makeReferral(TEST_CTX, {
      caseId,
      providerId: two!,
      disclosedTo: 'Someone',
      disclosedBy: 'Operator',
      method: 'phone',
      spokenDisclosureGiven: true,
      fromRequestId: requestId,
    })).rejects.toThrow(/different provider/);
  });

  it('refuses an already-answered request rather than re-answering it', async () => {
    const { caseId, eligible } = await anActiveCase();
    const providerId = eligible[0]!;
    const bench = await publishBench(TEST_CTX, { caseId, providerIds: [providerId] });
    const requestId = await ask(bench.shortlistId, providerId, caseId);

    await resolveRequest(TEST_CTX, requestId, 'withdrawn', 'Not going ahead.');

    await expect(makeReferral(TEST_CTX, {
      caseId,
      providerId,
      disclosedTo: 'Someone',
      disclosedBy: 'Operator',
      method: 'phone',
      spokenDisclosureGiven: true,
      fromRequestId: requestId,
    })).rejects.toThrow(/already withdrawn/);
  });
});

describe('what the household said about the referral', () => {
  it('reads back the feedback for a case and nothing from another', async () => {
    const [referral] = await db.query<{ id: string; case_id: string }>(
      `SELECT id, case_id FROM referrals ORDER BY referred_at LIMIT 1`,
    );
    expect(referral).toBeTruthy();
    const caseId = referral!.case_id;

    await db.query(
      `INSERT INTO referral_feedback (referral_id, referral_service_rating, would_refer_again, notes)
       VALUES ($1, 4, true, 'The call back was quick.')`,
      [referral!.id],
    );

    const mine = await feedbackForCase(TEST_CTX, caseId);
    expect(mine.some((f) => f.notes === 'The call back was quick.')).toBe(true);
    expect(mine.every((f) => f.referralServiceRating === null
      || (f.referralServiceRating >= 1 && f.referralServiceRating <= 5))).toBe(true);

    const other = (await workableCases()).find((c) => c.caseId !== caseId)!.caseId;
    const theirs = await feedbackForCase(TEST_CTX, other);
    expect(theirs.some((f) => f.notes === 'The call back was quick.')).toBe(false);
  });
});

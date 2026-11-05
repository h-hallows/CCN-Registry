/**
 * I12, through the submission queue. Migration 0008.
 *
 * The hole 0008 closed was that a provider could insert their own `credentials` row and
 * walk onto a shortlist, because `eligibility()` reads the presence of a row of the
 * required type as that requirement being met. The migration removed the write; this
 * suite pins down the console half — that the only thing which turns a submission into a
 * credential is an operator accepting it, and that accepting is all-or-nothing.
 *
 * Every provider here is created by the test rather than taken from the seed. The suite
 * shares one database across files (vitest runs it in a single fork), so a seeded
 * provider another file has already renewed a credential for would make the eligibility
 * assertions below depend on file order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { expectRejection, seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  addDays, asISODate, civilLA, eligibility, formatISODate,
} from '@h-hallows/core/domain';
import type { CredentialLike } from '@h-hallows/core/domain';
import type { CredentialType } from '@h-hallows/core/schema';
import {
  acceptSubmission, rejectSubmission, SubmissionError,
} from '@/lib/domain/credentialSubmissions';
import { countPendingSubmissions, listPendingSubmissions } from '@/lib/queries/submissions';

let db: DbHandle;
const d = (n: number) => formatISODate(addDays(civilLA(new Date()), n));

/**
 * An LVN holding everything required except a Live Scan — the exact shape of the
 * provider in the migration's own worked example.
 */
async function lvnMissingLiveScan(name: string): Promise<string> {
  const [provider] = await db.query<{ id: string }>(
    `INSERT INTO providers (full_name, type, status) VALUES ($1, 'LVN', 'active')
     RETURNING id`,
    [name],
  );
  const id = provider!.id;
  for (const type of ['lvn_license', 'tb_clearance', 'cpr_bls'] as const) {
    // nurse_license_inspected (§ 1812.528) makes the inspection record mandatory on a
    // nursing licence, so the fixture carries it too.
    const inspected = type === 'lvn_license';
    await db.query(
      `INSERT INTO credentials
         (provider_id, type, expires_on, verified_on, verified_by, verification_source,
          inspected_at, inspected_by, inspected_expiry_noted)
       VALUES ($1, $2, $3, $4, 'operator@example.com', 'Issuing body lookup', $5, $6, $7)`,
      [id, type, d(365), d(-1),
        inspected ? d(-1) : null, inspected ? 'operator@example.com' : null,
        inspected ? d(365) : null],
    );
  }
  return id;
}

async function submit(
  providerId: string,
  type: CredentialType,
  claims: { identifier?: string; documentUrl?: string; note?: string } = {},
): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO credential_submissions (provider_id, type, identifier, document_url, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [providerId, type, claims.identifier ?? null, claims.documentUrl ?? null,
      claims.note ?? null],
  );
  return row!.id;
}

async function liveCredentials(providerId: string) {
  return db.query<{ id: string; type: CredentialType; expires_on: string | null;
    verified_by: string; verification_source: string; identifier: string | null }>(
    `SELECT id, type, expires_on, verified_by, verification_source, identifier
       FROM credentials WHERE provider_id = $1 AND deleted_at IS NULL`,
    [providerId],
  );
}

async function isEligible(providerId: string): Promise<boolean> {
  const [p] = await db.query<{ type: never; transports: boolean; status: never }>(
    `SELECT type, transports, status FROM providers WHERE id = $1`, [providerId],
  );
  const creds = await db.query<{ type: never; expires_on: string | null }>(
    `SELECT type, expires_on FROM credentials
      WHERE provider_id = $1 AND deleted_at IS NULL`,
    [providerId],
  );
  return eligibility(
    p!,
    creds.map((c): CredentialLike => ({ type: c.type, expiresOn: asISODate(c.expires_on) })),
    new Date(),
  ).eligible;
}

beforeAll(async () => { db = await seededDb(); });

afterAll(async () => {
  // Take this file's providers back out of every roster query, so file order stays
  // irrelevant for the suites that sweep the whole roster. Soft-deleted rather than
  // deleted: credential_events is append-only at the database level, which is the point
  // of it, and a test is not a reason to make an exception.
  const mine = `(SELECT id FROM providers WHERE full_name LIKE '% Tester')`;
  await db.query(`DELETE FROM credential_submissions WHERE provider_id IN ${mine}`);
  await db.query(`UPDATE credentials SET deleted_at = now() WHERE provider_id IN ${mine}`);
  await db.query(`UPDATE providers SET deleted_at = now() WHERE full_name LIKE '% Tester'`);
});

describe('the queue shows what was handed in, and marks it as unverified', () => {
  it('lists submitted rows oldest first, with the provider and what they claim', async () => {
    const providerId = await lvnMissingLiveScan('Queue Order Tester');
    const older = await submit(providerId, 'live_scan', { identifier: 'A-111' });
    await db.query(
      `UPDATE credential_submissions SET submitted_at = now() - interval '2 days' WHERE id = $1`,
      [older],
    );
    const newer = await submit(providerId, 'tb_clearance', { identifier: 'B-222' });

    const pending = await listPendingSubmissions(TEST_CTX);
    const mine = pending.filter((s) => s.providerId === providerId).map((s) => s.id);
    expect(mine).toEqual([older, newer]);

    const first = pending.find((s) => s.id === older)!;
    expect(first.providerName).toBe('Queue Order Tester');
    expect(first.label).toBe('Live Scan');
    expect(first.claimedIdentifier).toBe('A-111');
    expect(first.renewsExisting).toBe(false);
    expect(await countPendingSubmissions()).toBe(pending.length);
  });
});

describe('accepting', () => {
  it('creates exactly one credentials row and leaves the submission pointing at it', async () => {
    const providerId = await lvnMissingLiveScan('Accept Once Tester');
    const submissionId = await submit(providerId, 'live_scan', { identifier: 'CLAIMED-999' });

    const before = await liveCredentials(providerId);
    expect(before.filter((c) => c.type === 'live_scan')).toHaveLength(0);

    const result = await acceptSubmission(TEST_CTX, {
      submissionId,
      identifier: 'DOJ-0001',
      expiresOn: null,
      verifiedOn: d(0),
      verificationSource: 'CA DOJ subsequent arrest notification',
    });
    expect(result.renewed).toBe(false);

    const after = await liveCredentials(providerId);
    const liveScans = after.filter((c) => c.type === 'live_scan');
    expect(liveScans).toHaveLength(1);
    expect(liveScans[0]!.id).toBe(result.credentialId);
    expect(after).toHaveLength(before.length + 1);

    const [submission] = await db.query<{
      state: string; credential_id: string | null; reviewed_by: string | null;
      reviewed_at: string | null;
    }>(
      `SELECT state, credential_id, reviewed_by, reviewed_at
         FROM credential_submissions WHERE id = $1`,
      [submissionId],
    );
    expect(submission!.state).toBe('accepted');
    expect(submission!.credential_id).toBe(result.credentialId);
    expect(submission!.reviewed_by).toBe(TEST_CTX.actor);
    expect(submission!.reviewed_at).not.toBeNull();
  });

  it('records the operator as the verifier, and never the provider’s own claim', async () => {
    const providerId = await lvnMissingLiveScan('Not Your Word Tester');
    const submissionId = await submit(providerId, 'live_scan', {
      identifier: 'WHAT-THE-PROVIDER-SAYS',
      note: 'verified_by: me',
    });

    const result = await acceptSubmission(TEST_CTX, {
      submissionId,
      identifier: 'WHAT-THE-OPERATOR-READ',
      expiresOn: d(400),
      verifiedOn: d(0),
      verificationSource: 'CA DOJ subsequent arrest notification',
    });

    const [credential] = await db.query<{
      verified_by: string; verification_source: string; identifier: string | null;
      expires_on: string | null;
    }>(
      `SELECT verified_by, verification_source, identifier, expires_on
         FROM credentials WHERE id = $1`,
      [result.credentialId],
    );
    expect(credential!.verified_by).toBe(TEST_CTX.actor);
    expect(credential!.verified_by).not.toBe('me');
    expect(credential!.verification_source).toBe('CA DOJ subsequent arrest notification');
    // The claimed identifier never reaches the credential unless the operator re-keys it.
    expect(credential!.identifier).toBe('WHAT-THE-OPERATOR-READ');
    expect(asISODate(credential!.expires_on)).toBe(d(400));
  });

  it('renews rather than duplicating when the provider already holds the credential', async () => {
    const providerId = await lvnMissingLiveScan('Renewal Tester');
    const submissionId = await submit(providerId, 'tb_clearance');

    const result = await acceptSubmission(TEST_CTX, {
      submissionId,
      expiresOn: d(730),
      verifiedOn: d(0),
      verificationSource: 'Clearance letter from issuing clinic',
    });
    expect(result.renewed).toBe(true);

    const tb = (await liveCredentials(providerId)).filter((c) => c.type === 'tb_clearance');
    expect(tb).toHaveLength(1);
    expect(asISODate(tb[0]!.expires_on)).toBe(d(730));
  });

  it('refuses to review the same submission twice', async () => {
    const providerId = await lvnMissingLiveScan('Twice Tester');
    const submissionId = await submit(providerId, 'live_scan');
    await acceptSubmission(TEST_CTX, {
      submissionId, expiresOn: null, verifiedOn: d(0),
      verificationSource: 'CA DOJ subsequent arrest notification',
    });
    await expect(acceptSubmission(TEST_CTX, {
      submissionId, expiresOn: null, verifiedOn: d(0),
      verificationSource: 'CA DOJ subsequent arrest notification',
    })).rejects.toThrow(SubmissionError);
  });

  it('refuses a nursing licence with no § 1812.528 inspection record', async () => {
    const providerId = await lvnMissingLiveScan('Uninspected Licence Tester');
    const submissionId = await submit(providerId, 'lvn_license', { identifier: 'VN-7781' });

    // The nurse_license_inspected CHECK would refuse it anyway; what is asserted here is
    // that the operator gets a sentence instead of a constraint name, and that nothing
    // was written on the way to finding out.
    await expect(acceptSubmission(TEST_CTX, {
      submissionId, expiresOn: d(700), verifiedOn: d(0),
      verificationSource: 'BRN license verification',
    })).rejects.toThrow(/1812\.528|inspect/i);

    const [row] = await db.query<{ state: string }>(
      `SELECT state FROM credential_submissions WHERE id = $1`, [submissionId],
    );
    expect(row!.state).toBe('submitted');

    const result = await acceptSubmission(TEST_CTX, {
      submissionId, expiresOn: d(700), verifiedOn: d(0),
      verificationSource: 'BRN license verification',
      inspection: { expiryNoted: d(700) },
    });
    const [credential] = await db.query<{
      inspected_by: string | null; inspected_expiry_noted: string | null;
    }>(
      `SELECT inspected_by, inspected_expiry_noted FROM credentials WHERE id = $1`,
      [result.credentialId],
    );
    expect(credential!.inspected_by).toBe(TEST_CTX.actor);
    expect(asISODate(credential!.inspected_expiry_noted)).toBe(d(700));
  });

  it('refuses an accept with no verification source', async () => {
    const providerId = await lvnMissingLiveScan('No Source Tester');
    const submissionId = await submit(providerId, 'live_scan');
    await expect(acceptSubmission(TEST_CTX, {
      submissionId, expiresOn: null, verifiedOn: d(0), verificationSource: '   ',
    })).rejects.toThrow(/verified/i);
    expect((await liveCredentials(providerId)).filter((c) => c.type === 'live_scan'))
      .toHaveLength(0);
  });
});

describe('rejecting', () => {
  it('creates zero credentials rows', async () => {
    const providerId = await lvnMissingLiveScan('Reject Tester');
    const submissionId = await submit(providerId, 'live_scan', { identifier: 'X-1' });
    const before = await liveCredentials(providerId);

    await rejectSubmission(TEST_CTX, {
      submissionId, reviewNote: 'Illegible scan; asked for a clearer copy.',
    });

    const after = await liveCredentials(providerId);
    expect(after).toHaveLength(before.length);
    expect(after.filter((c) => c.type === 'live_scan')).toHaveLength(0);

    const [submission] = await db.query<{
      state: string; credential_id: string | null; reviewed_by: string | null;
      review_note: string | null;
    }>(
      `SELECT state, credential_id, reviewed_by, review_note
         FROM credential_submissions WHERE id = $1`,
      [submissionId],
    );
    expect(submission!.state).toBe('rejected');
    expect(submission!.credential_id).toBeNull();
    expect(submission!.reviewed_by).toBe(TEST_CTX.actor);
    expect(submission!.review_note).toMatch(/Illegible/);
    expect(await isEligible(providerId)).toBe(false);
  });

  it('refuses a rejection with no stated reason', async () => {
    const providerId = await lvnMissingLiveScan('Silent Reject Tester');
    const submissionId = await submit(providerId, 'live_scan');
    await expect(rejectSubmission(TEST_CTX, { submissionId, reviewNote: '  ' }))
      .rejects.toThrow(SubmissionError);
    const [row] = await db.query<{ state: string }>(
      `SELECT state FROM credential_submissions WHERE id = $1`, [submissionId],
    );
    expect(row!.state).toBe('submitted');
  });
});

describe('the database refuses the half-done state on its own', () => {
  it('cannot mark a submission accepted with a null credential_id', async () => {
    const providerId = await lvnMissingLiveScan('Check Constraint Tester');
    const submissionId = await submit(providerId, 'live_scan');

    await expectRejection(
      () => db.query(
        `UPDATE credential_submissions
            SET state = 'accepted', reviewed_at = now(), reviewed_by = 'operator@example.com'
          WHERE id = $1`,
        [submissionId],
      ),
      /submission_accepted_has_credential/,
    );

    const [row] = await db.query<{ state: string }>(
      `SELECT state FROM credential_submissions WHERE id = $1`, [submissionId],
    );
    expect(row!.state).toBe('submitted');
  });

  it('cannot mark a submission reviewed with no reviewer', async () => {
    const providerId = await lvnMissingLiveScan('No Reviewer Tester');
    const submissionId = await submit(providerId, 'live_scan');
    await expectRejection(
      () => db.query(
        `UPDATE credential_submissions SET state = 'rejected' WHERE id = $1`,
        [submissionId],
      ),
      /submission_reviewed_has_reviewer/,
    );
  });
});

describe('I12 — a submission moves nobody; an accept does', () => {
  it('leaves a provider ineligible while their Live Scan is only submitted', async () => {
    const providerId = await lvnMissingLiveScan('Eligibility Tester');
    expect(await isEligible(providerId)).toBe(false);

    // This is the 0008 scenario verbatim: the provider asserts their own Live Scan.
    const submissionId = await submit(providerId, 'live_scan', {
      identifier: 'I checked it myself',
      note: 'verified_by: me',
    });

    // Handed in, visible to the operator, and worth nothing.
    expect((await listPendingSubmissions(TEST_CTX)).some((s) => s.id === submissionId))
      .toBe(true);
    expect(await isEligible(providerId)).toBe(false);
    expect((await liveCredentials(providerId)).filter((c) => c.type === 'live_scan'))
      .toHaveLength(0);

    await acceptSubmission(TEST_CTX, {
      submissionId,
      expiresOn: null,
      verifiedOn: d(0),
      verificationSource: 'CA DOJ subsequent arrest notification',
    });

    expect(await isEligible(providerId)).toBe(true);
  });

  it('leaves a provider ineligible after a rejection, however the submission was worded', async () => {
    const providerId = await lvnMissingLiveScan('Rejected Eligibility Tester');
    const submissionId = await submit(providerId, 'live_scan', {
      identifier: 'LS-CLEARED', note: 'Background check passed, see attached.',
    });
    await rejectSubmission(TEST_CTX, {
      submissionId, reviewNote: 'Document is for a different person.',
    });
    expect(await isEligible(providerId)).toBe(false);
  });
});

describe('the accept is one transaction', () => {
  it('writes no credential when the credential itself cannot be written', async () => {
    const providerId = await lvnMissingLiveScan('Bad Date Tester');
    const submissionId = await submit(providerId, 'live_scan');

    await expect(acceptSubmission(TEST_CTX, {
      submissionId,
      expiresOn: 'not-a-date',
      verifiedOn: d(0),
      verificationSource: 'CA DOJ subsequent arrest notification',
    })).rejects.toThrow();

    expect((await liveCredentials(providerId)).filter((c) => c.type === 'live_scan'))
      .toHaveLength(0);
    const [row] = await db.query<{
      state: string; credential_id: string | null; reviewed_at: string | null;
    }>(
      `SELECT state, credential_id, reviewed_at FROM credential_submissions WHERE id = $1`,
      [submissionId],
    );
    expect(row!.state).toBe('submitted');
    expect(row!.credential_id).toBeNull();
    expect(row!.reviewed_at).toBeNull();
  });

  /**
   * The failure that matters. The credential is written first and the submission is
   * marked accepted last, so a non-transactional implementation would leave a verified
   * credential behind — a provider made eligible by a review that never completed.
   * A trigger stands in for whatever makes that last statement fail in production.
   */
  it('rolls the credential back when marking the submission accepted fails', async () => {
    const providerId = await lvnMissingLiveScan('Rollback Tester');
    const submissionId = await submit(providerId, 'live_scan');
    const credentialsBefore = await liveCredentials(providerId);

    await db.exec(`
      CREATE OR REPLACE FUNCTION test_block_submission_review() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'test: review refused';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_block_submission_review
        BEFORE UPDATE ON credential_submissions
        FOR EACH ROW EXECUTE FUNCTION test_block_submission_review();
    `);

    try {
      await expect(acceptSubmission(TEST_CTX, {
        submissionId,
        expiresOn: null,
        verifiedOn: d(0),
        verificationSource: 'CA DOJ subsequent arrest notification',
      })).rejects.toThrow(/review refused/);
    } finally {
      await db.exec(`
        DROP TRIGGER IF EXISTS test_block_submission_review ON credential_submissions;
        DROP FUNCTION IF EXISTS test_block_submission_review();
      `);
    }

    // No credential, no credential_events row, no eligibility, submission untouched.
    expect(await liveCredentials(providerId)).toHaveLength(credentialsBefore.length);
    expect((await liveCredentials(providerId)).filter((c) => c.type === 'live_scan'))
      .toHaveLength(0);
    const events = await db.query(
      `SELECT 1 FROM credential_events e JOIN credentials c ON c.id = e.credential_id
        WHERE c.provider_id = $1 AND c.type = 'live_scan'`,
      [providerId],
    );
    expect(events).toHaveLength(0);
    expect(await isEligible(providerId)).toBe(false);

    const [row] = await db.query<{
      state: string; credential_id: string | null; reviewed_at: string | null;
      reviewed_by: string | null;
    }>(
      `SELECT state, credential_id, reviewed_at, reviewed_by
         FROM credential_submissions WHERE id = $1`,
      [submissionId],
    );
    expect(row!.state).toBe('submitted');
    expect(row!.credential_id).toBeNull();
    expect(row!.reviewed_at).toBeNull();
    expect(row!.reviewed_by).toBeNull();

    // And the same accept goes through once the obstruction is gone, so the test is
    // asserting a rollback rather than an input the function would always refuse.
    const result = await acceptSubmission(TEST_CTX, {
      submissionId,
      expiresOn: null,
      verifiedOn: d(0),
      verificationSource: 'CA DOJ subsequent arrest notification',
    });
    expect(result.credentialId).toBeTruthy();
    expect(await isEligible(providerId)).toBe(true);
  });
});

describe('the review is audited', () => {
  it('records the accept against the submission', async () => {
    const rows = await db.query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_log
        WHERE entity = 'credential_submission' ORDER BY at DESC LIMIT 10`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.action)).toContain('update');
  });
});

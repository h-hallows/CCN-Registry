/**
 * The supply side of the front door.
 *
 * `/for-providers` wrote to `provider_applications` and nothing in this console read
 * it, and nothing created a `providers` row — so the roster could not grow and every
 * provider in the system came from the seed.
 *
 * The thing worth testing hardest is what onboarding does NOT do. A provider arrives
 * with no credentials, because `eligibility()` counts the presence of a credential row
 * as that requirement being met — migration 0008 exists because a provider inserting
 * their own Live Scan was enough to make them eligible.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb, TEST_CTX } from '@h-hallows/core/testing';
import {
  ApplicationError, countUnhandledApplications, declineApplicant, onboardApplicant,
  recentlyDecidedApplications, unhandledApplications,
} from '@/lib/queries/applications';
import { getProviderWithStanding } from '@/lib/queries/providers';
import { shortlistFor } from '@/lib/queries/match';

let db: DbHandle;

beforeAll(async () => { db = await seededDb(); });

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

/** What the public form writes, areas as the slugs it submits. */
async function apply(over: Record<string, unknown> = {}): Promise<string> {
  const row = {
    full_name: 'Teresa Nakamura', phone: '(310) 555-4411',
    email: 'teresa@example.com', type: 'CNA', license_number: 'CNA-88213',
    areas: ['santa_monica', 'brentwood'], languages: ['English', 'Japanese'],
    specialties: ['dementia'], experience_note: 'Eleven years, mostly overnight.',
    message: 'Available from the new year.', ...over,
  };
  const inserted = await one<{ id: string }>(
    `INSERT INTO provider_applications
       (full_name, phone, email, type, license_number, areas, languages, specialties,
        experience_note, message)
     VALUES ($1,$2,$3,$4::provider_type,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [row.full_name, row.phone, row.email, row.type, row.license_number, row.areas,
      row.languages, row.specialties, row.experience_note, row.message],
  );
  return inserted.id;
}

const ONBOARD = {
  fullName: 'Teresa Nakamura',
  type: 'CNA' as const,
  areas: ['Santa Monica', 'Brentwood'],
  languages: ['English', 'Japanese'],
  specialties: ['dementia'],
  transports: false,
};

describe('seeing who applied', () => {
  it('shows an unanswered application and translates its areas', async () => {
    const id = await apply();
    const row = (await unhandledApplications(TEST_CTX)).find((a) => a.id === id);
    expect(row).toBeTruthy();
    // The form submits slugs; the roster holds what a person wrote, and the matcher
    // compares those by string equality.
    expect(row!.areas).toEqual(['Santa Monica', 'Brentwood']);
    expect(await countUnhandledApplications()).toBeGreaterThanOrEqual(1);
  });

  it('spots somebody already on the roster by licence number', async () => {
    const existing = await one<{ id: string; full_name: string; license_number: string }>(
      `SELECT id, full_name, license_number FROM providers
        WHERE license_number IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 1`);

    // A different person's name, the same licence — which is what identifies them.
    const id = await apply({
      full_name: 'Somebody Else', license_number: existing.license_number.toLowerCase(),
    });
    const row = (await unhandledApplications(TEST_CTX)).find((a) => a.id === id);
    expect(row!.possibleDuplicateId).toBe(existing.id);
    expect(row!.possibleDuplicateName).toBe(existing.full_name);
  });

  it('spots one by name when no licence was given', async () => {
    const existing = await one<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM providers WHERE deleted_at IS NULL ORDER BY id LIMIT 1`);
    const id = await apply({
      full_name: existing.full_name.toUpperCase(), license_number: null,
    });
    const row = (await unhandledApplications(TEST_CTX)).find((a) => a.id === id);
    expect(row!.possibleDuplicateId).toBe(existing.id);
  });

  it('does not invent a duplicate for somebody new', async () => {
    const id = await apply({ full_name: 'Wholly Unseen Person', license_number: 'ZZ-1' });
    const row = (await unhandledApplications(TEST_CTX)).find((a) => a.id === id);
    expect(row!.possibleDuplicateId).toBeNull();
  });
});

describe('putting somebody on the roster', () => {
  it('creates them inactive, with nothing verified', async () => {
    const id = await apply();
    const { providerId } = await onboardApplicant(TEST_CTX, {
      applicationId: id, ...ONBOARD,
    });

    const provider = await one<{ status: string; areas: string[]; full_name: string }>(
      `SELECT status::text AS status, areas, full_name FROM providers WHERE id = $1`,
      [providerId]);
    expect(provider.status).toBe('inactive');
    expect(provider.areas).toEqual(['Santa Monica', 'Brentwood']);

    const credentials = await db.query(
      `SELECT 1 FROM credentials WHERE provider_id = $1`, [providerId]);
    expect(credentials).toEqual([]);

    const application = await one<{ provider_id: string; handled_by: string }>(
      `SELECT provider_id, handled_by FROM provider_applications WHERE id = $1`, [id]);
    expect(application.provider_id).toBe(providerId);
    expect(application.handled_by).toBe(TEST_CTX.actor);
  });

  it('reaches no shortlist, which is the whole safeguard', async () => {
    /*
     * The failure this guards against is the one migration 0008 closed from the other
     * direction: `eligibility()` counts the presence of a credential row as that
     * requirement being met, so a provider onboarded WITH credentials copied from
     * their own application would be referable on the strength of what they typed.
     */
    const id = await apply();
    const { providerId } = await onboardApplicant(TEST_CTX, {
      applicationId: id, ...ONBOARD,
    });

    const standing = await getProviderWithStanding(TEST_CTX, providerId, new Date());
    expect(standing!.eligibility.eligible).toBe(false);

    const cases = await db.query<{ id: string }>(
      `SELECT id FROM cases WHERE deleted_at IS NULL AND status <> 'ended'`);
    for (const { id: caseId } of cases) {
      const shortlist = await shortlistFor(TEST_CTX, caseId);
      expect(shortlist!.eligible.some((e) => e.providerId === providerId)).toBe(false);
    }
  });

  it('keeps what they claimed in notes, out of the fields a household reads', async () => {
    const id = await apply({
      specialties: ['dementia'],
      experience_note: 'Twenty years of hospice work.',
    });
    const { providerId } = await onboardApplicant(TEST_CTX, {
      applicationId: id, ...ONBOARD, notes: 'Referred by Dolores.',
    });

    const provider = await one<{ notes: string; specialties: string[] }>(
      `SELECT notes, specialties FROM providers WHERE id = $1`, [providerId]);
    expect(provider.notes).toContain('Twenty years of hospice work.');
    expect(provider.notes).toContain('Referred by Dolores.');
    expect(provider.notes).toContain('Nothing verified yet.');
    // Specialties are shown to households beside verified documents, so only what the
    // operator confirmed goes there.
    expect(provider.specialties).toEqual(['dementia']);
  });

  it('refuses one somebody already dealt with', async () => {
    const id = await apply();
    await onboardApplicant(TEST_CTX, { applicationId: id, ...ONBOARD });
    await expect(onboardApplicant(TEST_CTX, { applicationId: id, ...ONBOARD }))
      .rejects.toThrow(/already dealt with/);
  });

  it('creates no provider when the form is short of a name', async () => {
    const id = await apply();
    const count = async () => Number((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM providers`))[0]!.n);
    const before = await count();

    await expect(onboardApplicant(TEST_CTX, {
      applicationId: id, ...ONBOARD, fullName: ' ',
    })).rejects.toThrow(ApplicationError);

    expect(await count()).toBe(before);
    const still = await one<{ handled_at: string | null }>(
      `SELECT handled_at::text FROM provider_applications WHERE id = $1`, [id]);
    expect(still.handled_at).toBeNull();
  });
});

describe('declining one', () => {
  it('records the reason and creates nobody', async () => {
    const id = await apply();
    await expect(declineApplicant(TEST_CTX, id, ' ')).rejects.toThrow(/why/i);
    await declineApplicant(TEST_CTX, id, 'Outside the area we cover.');

    const row = await one<{ handled_at: string; provider_id: string | null }>(
      `SELECT handled_at::text, provider_id FROM provider_applications WHERE id = $1`,
      [id]);
    expect(row.handled_at).not.toBeNull();
    expect(row.provider_id).toBeNull();

    expect((await unhandledApplications(TEST_CTX)).some((a) => a.id === id)).toBe(false);
    expect((await recentlyDecidedApplications(TEST_CTX)).some((a) => a.id === id))
      .toBe(true);
  });
});

/**
 * Reading the audit log by subject.
 *
 * § 3.8 exists so "who looked at this household" has an answer. It had none — not for
 * want of a screen, but because `(entity, entity_id)` was not a key into anything. A
 * read of a case's bench went in as ('shortlist', caseId): the entity naming one table
 * and the id belonging to another. The log was written faithfully from day one and could
 * not be queried, which is the dangerous direction — a short clean history for a
 * household that was read all afternoon.
 *
 * The tests that matter here are the ones that fail if the span under-reports. Over-
 * reporting is loud; under-reporting looks like a clean record.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@h-hallows/core/db';
import { seededDb } from '@h-hallows/core/testing';
import { AUDIT_ENTITY_NAMES, AUDIT_VIEW_NAMES } from '@h-hallows/core/domain';
import { audit, auditRead } from '@/lib/audit';
import {
  actorTrail, actors, collapse, householdTrail, integrity, providerTrail, recentWrites,
} from '@/lib/queries/audit';
import { getCase } from '@/lib/queries/cases';
import { shortlistFor } from '@/lib/queries/match';
import { documentsForCase } from '@/lib/queries/documents';

let db: DbHandle;

const WATCHER = { actor: 'watcher@example.com', ip: '203.0.113.9', userAgent: 'test' };

beforeAll(async () => { db = await seededDb(); });

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await db.query<T>(sql, params);
  if (!row) throw new Error(`fixture query returned no rows: ${sql}`);
  return row;
}

async function aCaseWithAHousehold(): Promise<{ caseId: string; householdId: string }> {
  const row = await one<{ id: string; household_id: string }>(
    `SELECT id, household_id FROM cases WHERE deleted_at IS NULL
      ORDER BY created_at LIMIT 1`,
  );
  return { caseId: row.id, householdId: row.household_id };
}

describe('a household\'s trail', () => {
  it('finds a read that was recorded against one of its cases', async () => {
    const { caseId, householdId } = await aCaseWithAHousehold();

    /*
     * Drive the real console read rather than inserting an audit row by hand. The thing
     * being tested is that what getCase() actually writes can be found by asking about
     * the household, and a hand-written fixture row would test the test.
     */
    await getCase(WATCHER, caseId);

    const trail = await householdTrail(WATCHER, householdId);
    expect(trail).not.toBeNull();

    const forTheCase = trail!.rows.filter(
      (r) => r.entityId === caseId && r.actor === WATCHER.actor && r.action === 'read',
    );
    expect(forTheCase.length, 'the case read is not on the household trail')
      .toBeGreaterThan(0);
    expect(forTheCase[0]!.entity).toBe('case');
    expect(forTheCase[0]!.mislabelled).toBe(false);
    expect(trail!.readers.map((r) => r.actor)).toContain(WATCHER.actor);
  });

  it('finds a read of the bench, which used to be filed under the wrong table', async () => {
    const { caseId, householdId } = await aCaseWithAHousehold();
    await shortlistFor({ ...WATCHER, actor: 'bench@example.com' }, caseId);

    const trail = await householdTrail(WATCHER, householdId);
    const row = trail!.rows.find(
      (r) => r.actor === 'bench@example.com' && r.entityId === caseId,
    );
    expect(row, 'the bench read did not reach the household trail').toBeDefined();
    // It is now recorded against the case, with what was read in the diff — rather than
    // against `shortlist` with a case's id under it.
    expect(row!.entity).toBe('case');
    expect(JSON.stringify(row!.diff)).toContain('candidate list');
  });

  it('finds a read of documents on both the case and the household', async () => {
    const { caseId, householdId } = await aCaseWithAHousehold();
    // One document on the household, so the read records something.
    await db.query(
      `INSERT INTO documents (kind, storage, household_id, filename, content_type,
                              byte_size, sha256_hex, bytes, uploaded_by)
       VALUES ('other', 'postgres', $1, 'note.txt', 'text/plain',
               octet_length('hello'::bytea), encode(sha256('hello'::bytea), 'hex'),
               'hello'::bytea, 'fixture@example.com')`,
      [householdId],
    );

    await documentsForCase({ ...WATCHER, actor: 'docs@example.com' }, caseId, householdId);

    const trail = await householdTrail(WATCHER, householdId);
    const mine = trail!.rows.filter((r) => r.actor === 'docs@example.com');
    /*
     * Two rows, one per subject. Recording only the case would leave the household's own
     * documents unaccounted for on the household's own trail, which is the question.
     */
    expect(mine.map((r) => r.entityId).sort())
      .toEqual([caseId, householdId].sort());
  });

  it('keeps one household\'s reads off another\'s trail', async () => {
    const first = await aCaseWithAHousehold();
    const second = await one<{ id: string; household_id: string }>(
      `SELECT id, household_id FROM cases
        WHERE deleted_at IS NULL AND household_id <> $1
        ORDER BY created_at LIMIT 1`,
      [first.householdId],
    );

    await getCase({ ...WATCHER, actor: 'nosy@example.com' }, first.caseId);

    const other = await householdTrail(WATCHER, second.household_id);
    expect(
      other!.rows.filter((r) => r.actor === 'nosy@example.com'),
      'a read of one household appeared on another household\'s trail',
    ).toEqual([]);
  });

  it('returns null for a household that does not exist', async () => {
    const trail = await householdTrail(
      WATCHER, '00000000-0000-0000-0000-000000000000',
    );
    expect(trail).toBeNull();
  });
});

describe('a row written before the vocabulary existed', () => {
  /*
   * These cannot be fixed. `audit_log` refuses UPDATE and DELETE, which is what makes it
   * evidence rather than a note — so the only question is whether the screen can still
   * attribute them. It can, because the match is on the id: a gen_random_uuid() belongs
   * to one row whatever the entity column was told to say.
   */
  it('is still attributed to the household, and marked as mislabelled', async () => {
    const { caseId, householdId } = await aCaseWithAHousehold();

    // What the old code wrote: the bench's name, the case's id. Inserted directly
    // because `audit()` would now refuse to produce it.
    await db.query(
      `INSERT INTO audit_log (actor, action, entity, entity_id)
       VALUES ('legacy@example.com', 'read', 'published_shortlist', $1)`,
      [caseId],
    );

    const trail = await householdTrail(WATCHER, householdId);
    const row = trail!.rows.find((r) => r.actor === 'legacy@example.com');
    expect(row, 'a mislabelled historical row was dropped from the trail').toBeDefined();
    expect(row!.storedEntity).toBe('published_shortlist');
    expect(row!.actualEntity).toBe('case');
    expect(row!.mislabelled).toBe(true);
  });

  it('is counted, rather than quietly left out of the summary', async () => {
    const log = await integrity(WATCHER);
    const found = log.mislabelled.find((m) => m.entity === 'published_shortlist');
    expect(found, 'the integrity summary does not mention it').toBeDefined();
    expect(found!.rows).toBeGreaterThan(0);
  });
});

describe('the screen is itself audited', () => {
  it('records opening a household\'s trail as a read of that household', async () => {
    const { householdId } = await aCaseWithAHousehold();
    const before = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE actor = $1 AND entity = 'household' AND entity_id = $2`,
      ['auditor@example.com', householdId],
    );

    await householdTrail({ ...WATCHER, actor: 'auditor@example.com' }, householdId);

    const after = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE actor = $1 AND entity = 'household' AND entity_id = $2
          AND diff ->> 'read' = 'the audit trail'`,
      ['auditor@example.com', householdId],
    );
    expect(Number(after.n)).toBeGreaterThan(Number(before.n) - 1);
    expect(Number(after.n)).toBeGreaterThan(0);
  });

  it('records the other three readings against the log itself', async () => {
    const ctx = { ...WATCHER, actor: 'reader@example.com' };
    await actors(ctx);
    await recentWrites(ctx);
    await actorTrail(ctx, 'nobody@example.com');

    const rows = await db.query<{ diff: unknown }>(
      `SELECT diff FROM audit_log WHERE actor = $1 AND entity = 'audit_log'`,
      [ctx.actor],
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});

describe('a provider\'s trail', () => {
  it('finds reads recorded against the provider', async () => {
    const provider = await one<{ id: string }>(
      `SELECT id FROM providers WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    );
    await auditRead({ ...WATCHER, actor: 'roster@example.com' }, 'provider', provider.id);

    const trail = await providerTrail(WATCHER, provider.id);
    expect(trail!.rows.some((r) => r.actor === 'roster@example.com')).toBe(true);
  });

  it('returns null for a provider that does not exist', async () => {
    expect(await providerTrail(WATCHER, '00000000-0000-0000-0000-000000000000'))
      .toBeNull();
  });
});

describe('the vocabulary is enforced in the application too', () => {
  it('refuses to put an id under a view', async () => {
    await expect(
      audit({ ...WATCHER, action: 'read', entity: 'today', entityId: crypto.randomUUID() }),
    ).rejects.toThrow(/view and cannot carry an id/);
  });

  it('writes every declared name without the database objecting', async () => {
    for (const entity of [...AUDIT_ENTITY_NAMES, ...AUDIT_VIEW_NAMES]) {
      await audit({ ...WATCHER, actor: 'every@example.com', action: 'read', entity });
    }
    const row = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE actor = 'every@example.com'`,
    );
    expect(Number(row.n)).toBe(AUDIT_ENTITY_NAMES.length + AUDIT_VIEW_NAMES.length);
  });

  it('is refused by the database for a name nobody declared', async () => {
    await expect(
      db.query(
        `INSERT INTO audit_log (actor, action, entity) VALUES ('x', 'read', 'invoices')`,
      ),
    ).rejects.toThrow(/audit_log_entity_vocabulary/);
  });
});

describe('the writes stream', () => {
  it('holds only writes, and says who made each one', async () => {
    const { caseId } = await aCaseWithAHousehold();
    await audit({
      ...WATCHER, actor: 'writer@example.com', action: 'update', entity: 'case',
      entityId: caseId, diff: { status: { from: 'open', to: 'matching' } },
    });

    const writes = await recentWrites(WATCHER);
    expect(writes.every((w) => w.action !== 'read')).toBe(true);

    const mine = writes.find((w) => w.actor === 'writer@example.com');
    expect(mine).toBeDefined();
    expect(mine!.label).toBe('Case');
  });
});

describe('collapsing repeated reads', () => {
  const base = {
    id: 'a', at: '2026-11-13T21:15:30.100Z', actor: 'a@example.com', action: 'read',
    storedEntity: 'household', entity: 'household' as const, label: 'Household',
    entityId: 'h1', actualEntity: 'household' as const, mislabelled: false,
    diff: null, ip: null,
  };

  it('counts identical neighbours in the same second as one row', () => {
    const out = collapse([
      { ...base, id: '1' },
      { ...base, id: '2', at: '2026-11-13T21:15:30.900Z' },
      { ...base, id: '3', at: '2026-11-13T21:15:30.950Z' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.times).toBe(3);
  });

  it('keeps a repeat in a later second on its own line', () => {
    const out = collapse([
      { ...base, id: '1' },
      { ...base, id: '2', at: '2026-11-13T21:15:31.000Z' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps reads apart when the diff differs', () => {
    const out = collapse([
      { ...base, id: '1', diff: { read: 'documents' } },
      { ...base, id: '2', diff: { read: 'portal accounts' } },
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps reads apart when the subject differs', () => {
    const out = collapse([
      { ...base, id: '1', entityId: 'h1' },
      { ...base, id: '2', entityId: 'h2' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('loses nothing: the counts add up to the rows it was given', () => {
    const rows = [
      { ...base, id: '1' },
      { ...base, id: '2' },
      { ...base, id: '3', actor: 'b@example.com' },
      { ...base, id: '4', at: '2026-11-13T22:00:00.000Z' },
    ];
    const out = collapse(rows);
    expect(out.reduce((n, r) => n + r.times, 0)).toBe(rows.length);
  });
});

/**
 * Who stands behind the primary on a case.
 *
 * WHY THIS DID NOT EXIST. `cases.alternate_provider_ids` has been in the schema since
 * migration 0001, where the column's own comment reads `-- target 2`. Two screens read
 * it. The Cover section of the case screen renders a row for each alternate with its
 * standing, and `/today` devotes a whole section to every live case holding fewer than
 * two ELIGIBLE ones, under a blurb reading "one illness away from a service failure" —
 * eight households were sitting in it.
 *
 * The only writer in either application was the seed. Four cases had alternates because
 * `src/db/seed.ts` put them there, and nothing an operator could do in the console would
 * ever move that count. Both screens pointed at `/match` to fix it, which was the right
 * screen and the wrong promise: `/match` can save a shortlist to the timeline, publish a
 * bench and record a referral, and none of the three touches this column. A number
 * counted in two places, acted on in none.
 *
 * WHAT AN ALTERNATE IS HERE. A reserve the household can fall back on if the primary
 * cannot cover — not somebody already referred. The seed is unambiguous about this and
 * it is worth stating, because the opposite reading is tempting: not one of the five
 * seeded alternates has a referral on its own case. The disclosure follows the same
 * reading. Naming somebody lets the household read their name, by migration 0007, and
 * `/portal/schedule` renders them under § 4.1 as the named cover — but a published
 * bench already shows a household candidate names before any referral, so this is the
 * durable form of something the registry does routinely, not a new kind of disclosure.
 * A referral is a separate act with its own § 1812.529 log sheet, and nothing here
 * makes one.
 *
 * WHICH MEANS THE FILTERS DECIDE, NOT THE FORM. An alternate who could not be referred
 * is a bench that is not there, so anything newly added is re-screened against
 * `screenCase` — the one implementation of who may be put in front of a household (I12)
 * — inside this transaction, and refused with the reason the match screen would have
 * given. Re-running it here rather than trusting the submitted list also catches a
 * credential that lapsed between the screen rendering and the operator submitting.
 *
 * AND WHY ALREADY-RECORDED NAMES ARE KEPT REGARDLESS. A credential lapses after the
 * fact; that is the entire reason `/today` counts eligible alternates rather than
 * recorded ones. Re-screening a name that is already on the case would make saving this
 * form a way to silently drop the cover a case already has, which is the opposite of
 * what the form is for.
 */
import { getDb, type Tx } from '@h-hallows/core/db';
import { audit, type AuditContext } from '@/lib/audit';
import { screenCase } from '@/lib/queries/match';
/*
 * The target is `THIN_BENCH_TARGET` and not a second constant beside it. It is one fact
 * — migration 0001 writes it as `-- target 2` on the column, `/today` buckets a case as
 * a thin bench below it, and this screen counts up to it — and a second declaration is
 * how two screens come to disagree about what "enough cover" means.
 */
import { THIN_BENCH_TARGET } from '@/lib/domain/buckets';

export class AlternateError extends Error {}

export interface AlternatesWritten {
  /** The names now standing, in the order they will be read in. */
  standing: string[];
  added: string[];
  removed: string[];
}

async function providerNames(
  run: Pick<Tx, 'query'>, ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await run.query<{ id: string; full_name: string }>(
    `SELECT id::text AS id, full_name FROM providers WHERE id = ANY($1::uuid[])`,
    [[...ids]],
  );
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

/**
 * The names currently standing, so a form can render a box already ticked for each.
 *
 * No audit row, for the reason `screenCase` gives for the same decision: this is part of
 * drawing a screen whose own read is already recorded, and a second row per render says
 * nothing the first does not.
 *
 * It exists because the alternates are a REPLACE. A provider whose credential lapsed
 * after they were recorded no longer appears in the eligible list, and a form built from
 * that list alone would render them unticked — so saving it would quietly drop the cover
 * the case already had, on the screen whose subject is how thin that cover is. They are
 * returned here precisely so they can be rendered, ticked, and left alone.
 */
export async function standingAlternates(
  caseId: string,
): Promise<{ providerId: string; fullName: string }[]> {
  const { query } = await getDb();
  return query<{ providerId: string; fullName: string }>(
    `SELECT p.id::text AS "providerId", p.full_name AS "fullName"
       FROM cases c
       JOIN LATERAL unnest(c.alternate_provider_ids) WITH ORDINALITY AS a(id, ord)
            ON TRUE
       JOIN providers p ON p.id = a.id
      WHERE c.id = $1 AND c.deleted_at IS NULL
      ORDER BY a.ord`,
    [caseId],
  );
}

/**
 * Set the alternates on a case to exactly this list.
 *
 * A replace rather than an add, because the screen that calls it shows every candidate
 * with a box ticked or not: an operator who unticks somebody means it, and an add-only
 * writer would leave them no way to say so.
 */
export async function recordAlternates(
  ctx: AuditContext,
  caseId: string,
  providerIds: readonly string[],
): Promise<AlternatesWritten> {
  const handle = await getDb();

  return handle.transaction(async (tx) => {
    const [before] = await tx.query<{
      primary_provider_id: string | null;
      alternate_provider_ids: string[] | null;
    }>(
      `SELECT c.primary_provider_id::text AS primary_provider_id,
              c.alternate_provider_ids::text[] AS alternate_provider_ids
         FROM cases c
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [caseId],
    );
    if (!before) throw new AlternateError('That case is not on file.');

    const current = (before.alternate_provider_ids ?? []).map(String);
    // Deduplicated with the order kept: the Cover table lists them in it, and so does
    // the household's own screen.
    const wanted = [...new Set(providerIds.map((id) => id.trim()).filter(Boolean))];

    const names = await providerNames(tx, [...new Set([...wanted, ...current])]);

    if (before.primary_provider_id && wanted.includes(before.primary_provider_id)) {
      throw new AlternateError(
        `${names.get(before.primary_provider_id) ?? 'The primary'} is the primary on `
        + 'this case and cannot also be the alternate. An alternate is who covers when '
        + 'the primary cannot, so a case naming one person as both has no cover at all.',
      );
    }

    const added = wanted.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !wanted.includes(id));

    if (added.length > 0) {
      const screen = await screenCase(tx, caseId);
      if (!screen) throw new AlternateError('That case is not on file.');
      const eligible = new Set(screen.eligible.map((e) => e.providerId));

      for (const id of added) {
        if (eligible.has(id)) continue;
        const excluded = screen.excluded.find((e) => e.providerId === id);
        throw new AlternateError(
          `${names.get(id) ?? 'That provider'} cannot stand as an alternate on this `
          + `case: ${excluded?.exclusion.detail ?? 'the filters for this case exclude them'}. `
          + 'An alternate who could not be referred is a bench that is not there.',
        );
      }
    }

    const standing = wanted.map((id) => names.get(id) ?? id);

    if (added.length === 0 && removed.length === 0) {
      return { standing, added: [], removed: [] };
    }

    await tx.query(
      `UPDATE cases
          SET alternate_provider_ids = $2::uuid[]
        WHERE id = $1 AND deleted_at IS NULL`,
      [caseId, wanted],
    );

    await audit({
      ...ctx, action: 'update', entity: 'case', entityId: caseId,
      diff: {
        wrote: ['alternate_provider_ids'],
        /*
         * Names, not identifiers, and deliberately. Everywhere else in this codebase a
         * diff records which field moved rather than its value, because the audit log is
         * append-only and copying a patient's address into it puts that address in a
         * second permanent place. A provider's name is not that: it is the registry's
         * own roster, the household is entitled to read it, and who was put on a case's
         * bench and when is the question this row exists to answer.
         */
        added: added.map((id) => names.get(id) ?? id),
        removed: removed.map((id) => names.get(id) ?? id),
        standing: standing.length,
        target: THIN_BENCH_TARGET,
      },
    }, tx);

    return {
      standing,
      added: added.map((id) => names.get(id) ?? id),
      removed: removed.map((id) => names.get(id) ?? id),
    };
  });
}

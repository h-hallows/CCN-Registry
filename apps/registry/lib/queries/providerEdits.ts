/**
 * The provider facts a referral depends on, and who may change them.
 *
 * WHY THIS DID NOT EXIST. `/applications` creates provider rows — `onboardApplicant`
 * names eleven columns and returns a roster entry — and `/match` offers a provider to a
 * household only where `screenCase` finds them eligible. What `screenCase` reads is the
 * provider's `type`, `status`, `transports`, `areas`, `availability` and credentials,
 * because `screen` excludes on each of them in turn and `requiredFor` derives the
 * credential matrix from the first and the third. Of those, the console could write
 * exactly two: `status`, through `setProviderReferralStatus`, and the credentials,
 * through the vault. The rest were rendered by `app/(app)/roster/[providerId]/page.tsx`
 * as nine read-only `Field`s, and the only writer for any of them in either application
 * was `src/db/seed.ts`.
 *
 * So the console could admit a provider and then never make them referable. `areas` set
 * from an application is never confirmed against the service area again; `availability`
 * is not written by onboarding at all, which means every provider the console has ever
 * created holds the column's `'{}'` default — and `screen` excludes an empty
 * availability from any case that states a schedule. Two seeded cases have nobody
 * eligible at all, and the operator's only recourse was to re-admit the provider from a
 * second application.
 *
 * WHICH FIELDS, AND WHY THESE ONES. The split is not invented here. Migration 0003's
 * `providers_provider_update_guard` already divides the row in two and says why in its
 * own comment: a referred provider may state their rate, availability, restrictions,
 * contact details and photo, and may not touch `status`, `areas`, `full_name`, `type`,
 * `license_number`, the paperwork dates or `notes` — `areas` among them because the
 * operator "confirms [it] against the service area rather than taking on trust". That
 * sentence names an operator write that had no implementation. The allow-list below is
 * the union of the facts `screenCase` reads and the facts that guard assigns to one side
 * or the other, and the audit diff records which side each written column came from, so
 * the log can later distinguish a fact the registry confirmed from one a provider stated
 * down a telephone.
 *
 * WHAT IS DELIBERATELY NOT HERE, each because something else already owns it:
 *
 *  - `status`. `setProviderReferralStatus` owns it, demands a reason, and appends that
 *    reason to `notes`. A general profile form that also carried a status select would
 *    make a forward-only referral stop (I4) the side effect of correcting a phone
 *    number, with no reason recorded.
 *  - `notes`. The operator's own record, and `setProviderReferralStatus` appends to it.
 *    A free-text box rendering it and posting it back would let one save silently erase
 *    the dated history of why somebody is `do_not_refer`.
 *  - `rate_hourly` and `rate_notes`. I5 and § 1812.5095(b)(3): the figure is the nurse's
 *    own and the registry's fee is a separate charge to the household. § 1812.530 bars
 *    charging a nurse anything and § 1812.531 bars splitting her fee, so the one thing
 *    the registry must never look like it did is set the number. `setProviderStatedRate`
 *    already refuses to write it unless the caller states the provider stated it; it
 *    keeps that job, on its own form, behind its own confirmation. Folding it in here
 *    would make restating a rate the by-product of saving an area.
 *  - `license_number`, and every credential fact. The licence is verified in the vault
 *    against the issuing body, with the § 1812.528 physical inspection recorded beside
 *    it. A plain text box on the profile would put an unverified licence number next to
 *    a verified one with nothing to tell them apart. Live Scan is the sharpest case:
 *    Penal Code § 11105.2 governs those records, nothing in this codebase stores a
 *    result, and the vault's `verification_source` is the only place a background check
 *    is spoken about at all.
 *  - `full_name`, the paperwork dates, `bio`, `photo_url` and `photo_consent_on`. The
 *    name is the one already written into filed disclosures and timeline entries; the
 *    dates assert that a document exists, which the Documents section is how you make
 *    true; the bio and the photograph are the provider's own words and image, and the
 *    photograph's consent is a consent the operator cannot give on their behalf.
 *
 * THE DANGEROUS CASE IS ALLOWED, AND SAID OUT LOUD. A change can take a provider off
 * every shortlist: moving them to a type whose required credentials they do not hold,
 * turning `transports` on and adding two requirements, or dropping the area or the shift
 * a live case is served under. Where that provider is standing on a live case — awaiting
 * an answer, engaged, or named as the cover — the write still happens, and the operator
 * is told which households it reached.
 *
 * It is allowed rather than refused for three reasons. Eligibility is forward-looking by
 * construction: I12 governs who may be PUT IN FRONT OF a household, and I4 leaves the
 * registry one lever, which is to stop referring — neither says anything about who may
 * stay engaged, and this write touches no engagement. A record that cannot be corrected
 * while it matters is a record that has to stay wrong, which is the argument
 * `lib/queries/statutoryFacts.ts` makes for the same decision about the register. And a
 * refusal would be the wrong shape anyway: the provider who turns out to be an LVN
 * rather than an RN is most urgently wrong on the case they are already serving.
 *
 * What a refusal would have bought is the operator's attention, so that is bought
 * directly. The before-and-after is taken from `screenCase` — the one implementation of
 * who may be put in front of a household (I12) — re-run inside this transaction for each
 * live case, so the warning names the same reason the match screen would print, and a
 * filter added to `screen` later is covered without anything here changing.
 */
import { getDb, type Tx } from '@h-hallows/core/db';
import { audit, type AuditContext } from '@/lib/audit';
import { eligibility, looksLikeUntranslatedSlug, type CredentialLike } from '@h-hallows/core/domain';
import { providerType, shiftBlock, type ProviderType } from '@h-hallows/core/schema';
import { asDate, setProviderStatedRate } from '@/lib/queries/providers';
import { screenCase } from '@/lib/queries/match';

export class ProviderEditError extends Error {}

/**
 * The types the roster holds, off the `provider_type` enum rather than written out.
 *
 * § 3.3's credential matrix and § 4.3's scope-of-practice table are both keyed by this
 * list, so a sixth type is a migration and a reviewed change to `REQUIRED` and
 * `PERMITTED` — not a value a select can offer because somebody added it to an array.
 */
export const PROVIDER_TYPES = providerType.enumValues;

/**
 * The days an availability block can name.
 *
 * `providers.availability` and `cases.schedule` are `text[]` of `Day:Block`, compared by
 * `overlap` with set membership — so `Mon:am` is not a typo that shows up as a wrong
 * answer, it is a value that matches no case for as long as it is there. That is the
 * failure this vocabulary exists to refuse, and it is why the blocks come off the
 * `shift_block` enum rather than being written out a fourth time: the database already
 * holds that list, and a copy is how two lists come to disagree.
 *
 * The days have no such declaration anywhere — `src/db/seed.ts` and
 * `app/(app)/roster/page.tsx` each write them out — so this is the first one, and the
 * place that validates them is the right home for it.
 */
export const SHIFT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export const SHIFT_BLOCKS = shiftBlock.enumValues;

/** Every block an operator may tick, in the order a week is read in. */
export const AVAILABILITY_BLOCKS: readonly string[] = SHIFT_DAYS
  .flatMap((day) => SHIFT_BLOCKS.map((block) => `${day}:${block}`));

/**
 * The columns this module writes, split by who the record says they belong to.
 *
 * Both lists are read straight off migration 0003's guard: `type`, `transports` and
 * `areas` are columns it forbids a provider to change, the rest are columns it allows
 * them. Recording the split in the audit diff is the only way the log can answer, later,
 * whether a stated fact was stated by the person it is about.
 */
const REGISTRY_CONFIRMED = ['type', 'transports', 'areas'] as const;

const PROVIDER_STATED = [
  'availability', 'languages', 'specialties', 'restrictions', 'preferred_name',
  'phone', 'email', 'max_travel_min',
] as const;

export interface ProviderFactsInput {
  type: ProviderType;
  transports: boolean;
  /** Order is meaningful: `areaRank` is the index of the case's area in this list. */
  areas: readonly string[];
  maxTravelMin: number | null;
  availability: readonly string[];
  languages: readonly string[];
  specialties: readonly string[];
  restrictions: string | null;
  preferredName: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Something worth saying about a write that still happened.
 *
 * Handed back to the screen rather than recorded and swallowed, for the reason
 * `lib/queries/statutoryFacts.ts` gives for the same shape: an operator who has just
 * taken a provider off a live household's shortlist is entitled to read that at the
 * moment it happens, not to have it discoverable afterwards in a log that says they
 * were told.
 */
export interface ProviderEditNote {
  /** Short machine-ish tag, for the audit diff. */
  concern: string;
  /** What to say to the operator. */
  message: string;
}

export interface ProviderFactsWritten {
  /** Column names that actually changed. Empty where the form was submitted unchanged. */
  changed: string[];
  notes: ProviderEditNote[];
  /** Whether the provider clears I12 now, which is what the roster badge reads. */
  eligible: boolean;
  /**
   * The live cases this provider stands on, so the caller can revalidate them.
   *
   * The writer is the only thing that knows which they are, and the screens that read
   * them — the case Cover table, the match screen's eligible list — change the moment
   * one of these columns moves. A caller left to guess would revalidate the roster and
   * leave a household's cover reading the old answer.
   */
  standingCaseIds: string[];
}

function trimmed(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function same(a: string | null, b: string | null): boolean {
  return (a ?? '') === (b ?? '');
}

/**
 * Trim, drop the blanks, drop the repeats, keep the order.
 *
 * The order is not tidiness. `screen` reports `areaRank` as the index of the household's
 * area in the provider's list and the match screen sorts on it, so re-sorting these
 * alphabetically here would quietly reorder every shortlist in the console.
 */
function list(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

/** Two text arrays as the database would compare them: same values, same order. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

interface Standing {
  caseId: string;
  household: string;
  /** Why the filters would exclude them now, in the words the match screen prints. */
  excludedFor: string | null;
}

/**
 * The live cases this provider is standing on, and whether the filters still clear them.
 *
 * Standing means one of three things, and all three are a household's expectation rather
 * than a row in a table: a referral with no outcome recorded is one the household has not
 * answered yet, a referral recorded as `engaged` is a placement, and a name in
 * `alternate_provider_ids` is the cover `/today` counts — which it counts ELIGIBLE, so a
 * provider made ineligible re-thins a bench that screen had stopped reporting.
 *
 * Ended cases are left out. Their referral record is history and no filter is read
 * against them again.
 */
async function standingOn(tx: Tx, providerId: string): Promise<Standing[]> {
  const rows = await tx.query<{ case_id: string; household: string }>(
    `SELECT DISTINCT c.id::text AS case_id, h.display_name AS household
       FROM cases c
       JOIN households h ON h.id = c.household_id
      WHERE c.deleted_at IS NULL
        AND c.status <> 'ended'
        AND (c.primary_provider_id = $1
             OR $1 = ANY(c.alternate_provider_ids)
             OR EXISTS (SELECT 1 FROM referrals r
                         WHERE r.case_id = c.id AND r.provider_id = $1
                           AND (r.outcome IS NULL OR r.outcome = 'engaged')))
      ORDER BY h.display_name`,
    [providerId],
  );

  const out: Standing[] = [];
  for (const row of rows) {
    const screen = await screenCase(tx, row.case_id);
    const excluded = screen?.excluded.find((e) => e.providerId === providerId);
    out.push({
      caseId: row.case_id,
      household: row.household,
      excludedFor: excluded ? excluded.exclusion.detail : null,
    });
  }
  return out;
}

/** One note naming the households a save has just taken this provider away from. */
function lostCoverNote(lost: Standing[], fullName: string): ProviderEditNote | null {
  if (lost.length === 0) return null;
  const named = lost.map((s) => `${s.household} (${s.excludedFor})`).join('; ');
  return {
    concern: 'ineligible_while_standing',
    message: `Saved, and ${fullName} no longer clears the filters on ${lost.length === 1
      ? 'a live case they are standing on'
      : `${lost.length} live cases they are standing on`}: ${named}. `
      + 'No engagement has been changed — the registry cannot end one — but they will '
      + 'not be offered for these households again until this is put right, and any '
      + 'case counting them as cover is now a thin bench.',
  };
}

/**
 * Set the provider facts a referral depends on.
 *
 * One statement naming its eleven columns rather than an UPDATE assembled from what the
 * form posted, for the reason `recordHouseholdFacts` gives: a statement built from the
 * submission is how `status` or `notes` changes because a field arrived that nobody
 * meant to send. A column added to the allow-list is a reviewed edit to this file.
 */
export async function recordProviderFacts(
  ctx: AuditContext,
  providerId: string,
  input: ProviderFactsInput,
): Promise<ProviderFactsWritten> {
  if (!(PROVIDER_TYPES as readonly string[]).includes(input.type)) {
    throw new ProviderEditError(
      `${input.type} is not a provider type this registry refers. `
      + `The roster holds ${PROVIDER_TYPES.join(', ')}.`,
    );
  }

  const next = {
    type: input.type,
    transports: input.transports,
    areas: list(input.areas),
    maxTravelMin: input.maxTravelMin,
    availability: list(input.availability),
    languages: list(input.languages),
    specialties: list(input.specialties),
    restrictions: trimmed(input.restrictions),
    preferredName: trimmed(input.preferredName),
    phone: trimmed(input.phone),
    email: trimmed(input.email),
  };

  if (next.maxTravelMin !== null
      && (!Number.isInteger(next.maxTravelMin) || next.maxTravelMin <= 0)) {
    throw new ProviderEditError(
      'How far they will travel is a number of minutes above nothing. Leave it empty '
      + 'if they have not said.',
    );
  }

  /*
   * A block the filters can never match is refused rather than stored.
   *
   * `overlap` compares these strings to `cases.schedule` by set membership, so a block
   * written any other way does not read as a near miss — it excludes the provider from
   * every case that states a schedule, silently, for as long as it is on the record.
   * That is the shape of bug `src/domain/areas.ts` was written to kill one layer along,
   * and the reason it is worth refusing a save over.
   */
  const strangeBlocks = next.availability
    .filter((b) => !AVAILABILITY_BLOCKS.includes(b));
  if (strangeBlocks.length > 0) {
    throw new ProviderEditError(
      `${strangeBlocks.join(', ')} is not a shift this registry schedules against. `
      + `A block is a day and a window — ${AVAILABILITY_BLOCKS[0]} — and the match `
      + 'filters compare it to the household’s requested pattern exactly, so one '
      + 'written any other way takes them off every case that states a schedule.',
    );
  }

  /*
   * And an area written as a slug, for the same reason and with the same consequence.
   *
   * `looksLikeUntranslatedSlug` exists because `households.cr_area` holding
   * `santa_monica` matches no provider ever, and `screen` compares the two sides by
   * exact text. The mistake is just as available on this side of the comparison — a
   * provider whose areas read `santa_monica` is served to nobody — and the fix is a
   * sentence to the operator rather than a translation, because translating would mean
   * writing a value they did not type.
   */
  const slugAreas = next.areas.filter((a) => looksLikeUntranslatedSlug(a));
  if (slugAreas.length > 0) {
    throw new ProviderEditError(
      `Write an area as a person would — Santa Monica, not ${slugAreas[0]}. The match `
      + 'filters compare a provider’s areas to the household’s by exact text, '
      + 'and a household record never holds the underscored form, so this one would '
      + 'serve nobody.',
    );
  }

  const handle = await getDb();

  return handle.transaction(async (tx) => {
    const [before] = await tx.query<{
      full_name: string; status: 'active' | 'inactive' | 'do_not_refer';
      type: ProviderType; transports: boolean; areas: string[] | null;
      max_travel_min: number | null; availability: string[] | null;
      languages: string[] | null; specialties: string[] | null;
      restrictions: string | null; preferred_name: string | null;
      phone: string | null; email: string | null;
    }>(
      `SELECT full_name, status, type, transports, areas, max_travel_min, availability,
              languages, specialties, restrictions, preferred_name, phone, email
         FROM providers
        WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
      [providerId],
    );
    if (!before) throw new ProviderEditError('That provider is not on the roster.');

    const changed: string[] = [];
    if (before.type !== next.type) changed.push('type');
    if (Boolean(before.transports) !== next.transports) changed.push('transports');
    if (!sameList(before.areas ?? [], next.areas)) changed.push('areas');
    if ((before.max_travel_min ?? null) !== (next.maxTravelMin ?? null)) {
      changed.push('max_travel_min');
    }
    if (!sameList(before.availability ?? [], next.availability)) changed.push('availability');
    if (!sameList(before.languages ?? [], next.languages)) changed.push('languages');
    if (!sameList(before.specialties ?? [], next.specialties)) changed.push('specialties');
    if (!same(before.restrictions, next.restrictions)) changed.push('restrictions');
    if (!same(before.preferred_name, next.preferredName)) changed.push('preferred_name');
    if (!same(before.phone, next.phone)) changed.push('phone');
    if (!same(before.email, next.email)) changed.push('email');

    /*
     * Whether they clear I12 is a question about the record, not about whether the
     * operator happened to change anything just now — so it is answered either way,
     * before the early return. A form that comes back saying only "nothing had changed"
     * about a provider who still cannot be referred is the screen agreeing with itself
     * instead of answering.
     *
     * One read of the credentials serves both answers, because this write cannot touch
     * them: `type` and `transports` move the requirement, never what is held.
     */
    const today = new Date();
    const credentials = await creds(tx, providerId);
    const held = { status: before.status };
    const wasEligible = eligibility(
      { ...held, type: before.type, transports: Boolean(before.transports) },
      credentials, today,
    );
    const willBe = eligibility(
      { ...held, type: next.type, transports: next.transports }, credentials, today,
    );

    if (changed.length === 0) {
      return {
        changed,
        notes: blockedNote(wasEligible.reason, wasEligible.eligible) ?? [],
        eligible: wasEligible.eligible,
        standingCaseIds: (await standingOn(tx, providerId)).map((s) => s.caseId),
      };
    }

    /*
     * Who they were clearing before the write, taken from `screenCase` rather than
     * worked out from the fields that moved. A filter added to `screen` later is then
     * covered by this warning without anything here changing — and the reason the
     * operator reads is the one the match screen would have printed beside the name.
     */
    const was = await standingOn(tx, providerId);

    await tx.query(
      `UPDATE providers
          SET type = $2::provider_type, transports = $3, areas = $4::text[],
              max_travel_min = $5, availability = $6::text[], languages = $7::text[],
              specialties = $8::text[], restrictions = $9, preferred_name = $10,
              phone = $11, email = $12, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [
        providerId, next.type, next.transports, next.areas, next.maxTravelMin,
        next.availability, next.languages, next.specialties, next.restrictions,
        next.preferredName, next.phone, next.email,
      ],
    );

    const now = await standingOn(tx, providerId);
    const clearedBefore = new Set(was.filter((s) => s.excludedFor === null).map((s) => s.caseId));
    const lost = now.filter((s) => s.excludedFor !== null && clearedBefore.has(s.caseId));

    const notes: ProviderEditNote[] = [];
    const lostNote = lostCoverNote(lost, before.full_name);
    if (lostNote) notes.push(lostNote);
    const blocked = blockedNote(willBe.reason, willBe.eligible);
    if (blocked) notes.push(...blocked);

    await audit({
      ...ctx, action: 'update', entity: 'provider', entityId: providerId,
      diff: {
        wrote: changed,
        /*
         * Which columns moved, and which side of migration 0003's line each came from.
         * Not what they moved to: the record itself holds the current value, and the
         * audit log is append-only, so a diff carrying a provider's telephone number
         * puts that number in a second permanent place. The one exception is `type`,
         * which is recorded with its values because it decides which credentials are
         * required at all — "the credential matrix changed" is not answerable from a
         * column name alone.
         */
        registryConfirmed: changed.filter(
          (c) => (REGISTRY_CONFIRMED as readonly string[]).includes(c)),
        providerStated: changed.filter(
          (c) => (PROVIDER_STATED as readonly string[]).includes(c)),
        ...(changed.includes('type') ? { type: { from: before.type, to: next.type } } : {}),
        eligible: { from: wasEligible.eligible, to: willBe.eligible },
        casesNoLongerCleared: lost.map((s) => s.caseId),
        notes: notes.map((n) => n.concern),
      },
    }, tx);

    return {
      changed, notes, eligible: willBe.eligible,
      standingCaseIds: now.map((s) => s.caseId),
    };
  });
}

/** What `eligibility` needs, with a revoked credential left in so it can discount it. */
async function creds(tx: Tx, providerId: string): Promise<CredentialLike[]> {
  const rows = await tx.query<{
    type: string; expires_on: string | null; deleted_at: string | null;
    verified_on: string | null;
  }>(
    `SELECT type::text AS type, expires_on, deleted_at, verified_on
       FROM credentials WHERE provider_id = $1`,
    [providerId],
  );
  return rows.map((r) => ({
    type: r.type as CredentialLike['type'],
    expiresOn: asDate(r.expires_on),
    deletedAt: r.deleted_at === null ? null : String(r.deleted_at),
    verifiedOn: asDate(r.verified_on),
  }));
}

/**
 * What the save leaves blocking, named.
 *
 * A type change is the write most likely to produce this: moving somebody from HCA to RN
 * adds an RN licence to `requiredFor` and the roster badge goes red on a provider who
 * was referable a moment ago. The operator should read why from the form they just
 * submitted rather than from the badge.
 */
function blockedNote(reason: string | null, eligible: boolean): ProviderEditNote[] | null {
  if (eligible || !reason) return null;
  return [{
    concern: 'not_eligible',
    message: `Saved, and this provider is on no shortlist: ${reason}. There is no `
      + 'override — record what is missing in the credential vault and they become '
      + 'eligible immediately.',
  }];
}

/**
 * Record the rate the provider stated, through the writer that already owns it.
 *
 * WHY THIS WRAPPER AND NOT A SECOND WRITER. `setProviderStatedRate` has been exported
 * from `lib/queries/providers.ts` since the rate column existed and nothing in `app/`,
 * `components/` or `lib/` has ever called it — a provider-rate writer, present, correct
 * and unreachable, which is the same defect as the read-only roster one layer up. It
 * keeps the write. This adds the two things the console needs before an operator can be
 * given the form, and nothing else.
 *
 * THE FIRST IS THE ATTESTATION. § 1812.530 forbids charging a nurse anything and
 * § 1812.531 forbids splitting her fee, and I5 is how those read in code: nothing in
 * this codebase computes, suggests, caps or defaults the figure. `rate_hourly` is the
 * nurse's own hourly rate — the provider portal's `/pro/rate` writes the same column
 * from the provider's own session, and migration 0003's guard lists it among the facts a
 * referred provider may change about themselves. The registry's charge is a different
 * number on a different table, `cases.fee_pct`, read against the § 1812.527 schedule.
 * So an operator typing into this column is transcribing something a nurse said, and
 * `statedBy: 'provider'` is an assertion about the world that only the caller can make.
 * It is made explicitly, by a parameter the form cannot omit, so that the console cannot
 * reach the rate column without somebody affirming where the figure came from.
 *
 * THE SECOND IS THAT THE PROVIDER EXISTS. `setProviderStatedRate` reads the row, writes
 * it and audits — and on an id that is not on the roster, or has been soft-deleted, the
 * read comes back empty, the UPDATE matches nothing and the audit row still goes in,
 * recording a rate change against a provider that was not changed. It is append-only, so
 * that entry is permanent. The existence check belongs with the call rather than in a
 * function another application's provider path also uses.
 *
 * WHAT IS STILL NOT RECORDED, and it is a real gap rather than a decision: the audit row
 * says which columns moved and which operator moved them, and has nowhere to say that
 * the provider stated the figure. The attestation is enforced and not kept. `providers`
 * would need a `rate_stated_by` and `rate_stated_on` to hold it, which is a core
 * migration — the same shape of recommendation `recordHouseholdFacts` makes about the
 * physician guard.
 */
export async function recordStatedRate(
  ctx: AuditContext,
  providerId: string,
  input: {
    /** Null where they would rather talk about it, which is a normal answer. */
    rateHourly: string | null;
    rateNotes: string | null;
    /** The operator affirming the provider stated this figure. */
    statedByProvider: boolean;
  },
): Promise<{ changed: boolean; rateHourly: string | null }> {
  if (!input.statedByProvider) {
    throw new ProviderEditError(
      'A rate goes on the record because the provider stated it. Civil Code '
      + '§ 1812.530 bars this registry from charging a nurse anything and '
      + '§ 1812.531 from taking a share of what she charges, so nothing here sets, '
      + 'suggests or caps the figure — confirm she said it, or leave it as it is.',
    );
  }

  const rateHourly = trimmed(input.rateHourly);
  const rateNotes = trimmed(input.rateNotes);

  const { query } = await getDb();
  const [before] = await query<{ rate_hourly: string | null; rate_notes: string | null }>(
    `SELECT rate_hourly::text AS rate_hourly, rate_notes
       FROM providers WHERE id = $1 AND deleted_at IS NULL`,
    [providerId],
  );
  if (!before) throw new ProviderEditError('That provider is not on the roster.');

  /*
   * Compared as numbers, not as text. `rate_hourly` is `numeric(6, 2)` and comes back
   * as `68.00`, so a form posting the `68` it was rendered with would read as a change
   * on every save and put an audit row in an append-only table for a write that moved
   * nothing.
   */
  const asNum = (v: string | null): number | null => (v === null ? null : Number(v));
  const changed = asNum(before.rate_hourly) !== asNum(rateHourly)
    || (before.rate_notes ?? '') !== (rateNotes ?? '');
  if (!changed) return { changed: false, rateHourly: before.rate_hourly };

  await setProviderStatedRate(ctx, providerId, 'provider', rateHourly, rateNotes);
  return { changed: true, rateHourly };
}

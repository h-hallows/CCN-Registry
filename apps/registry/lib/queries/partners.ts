/**
 * Referral partners — the discharge planners, care managers and attorneys who send
 * families here. Web build spec § 4.3, W11.
 *
 * NOTHING HERE TOUCHES MONEY, and nothing should be added that does. Civil Code
 * § 1812.531 forbids a nurses' registry from splitting a fee with anyone, and COUNSEL.md
 * question 3 is open on what, if anything, a partner may be compensated for. So this
 * holds a name, an organisation, a way to reach them, and a count of what they sent. No
 * rate, no percentage, no credit, no balance, and no field that could become one.
 *
 * The counts are a measure of where the work comes from, which § 8 needs in order to
 * answer whether the binding constraint is demand or capacity.
 */
import { getDb } from '@h-hallows/core/db';
import { audit, auditRead, type AuditContext } from '@/lib/audit';

export class PartnerError extends Error {}

/**
 * THE ONE DEFINITION of a family a referral partner sent us. Written here and nowhere
 * else, and imported by every screen that reports the figure.
 *
 * The attribution is a FOREIGN KEY, and it is load-bearing for a reason that has nothing
 * to do with reporting: `partner_referrals()` is scoped by it, so the key is what
 * decides who may read a referral and, once the household consents, its outcome. The
 * free-text source line typed on an enquiry decides nothing and is not this.
 *
 * THE KEY IS WRITTEN IN TWO PLACES, and that is how /partners and /measure came to
 * disagree in front of an operator. The front door writes `inquiries.partner_id`;
 * `convertInquiry` copies it onto `households.partner_id`, which is the record that
 * outlives the enquiry leaving the queue. This query read the first and never the
 * second, so a partner the household records credit with three families showed nothing
 * sent at all on the one screen that owns referral partners.
 *
 * So a family is counted ONCE, keyed by the household where there is one and by the
 * enquiry where there is not. Counting the two tables separately and adding them would
 * double every referral that converted. And `deleted_at` is applied to both legs rather
 * than to one: a predicate on one leg of a union and not the other is how two counts of
 * the same fact drift apart without anybody changing a definition.
 *
 * ONCE, EXCEPT WHERE THE TWO COLUMNS NAME TWO DIFFERENT PARTNERS. The group is
 * (partner, family), so a family whose enquiry credits one partner and whose household
 * credits another is two rows and the total reads one family too many. That is asserted
 * in tests/partners.test.ts rather than smoothed over: counting it once means choosing
 * whose credit survives, nothing in the data says whose, and attributing it to one key
 * would stop the per-partner cards summing to the header — the defect this query was
 * rewritten to end. `attributionDisagreements()` puts that state on /partners above the
 * counts instead, and the figure returns to one family when somebody corrects it.
 */
export const PARTNER_REFERRALS_CTE = `
  partner_referrals AS (
    SELECT partner_id, family,
           bool_or(became) AS became,
           min(at)         AS sent_at
      FROM (
        /*
         * What the front door recorded. A household that has since been soft-deleted
         * leaves the enquiry counted as sent — they did send it — and not counted as a
         * household on the books, which is why the join decides "became" rather than
         * household_id IS NOT NULL deciding it.
         */
        SELECT i.partner_id,
               coalesce(h.id::text, 'inquiry:' || i.id::text) AS family,
               (h.id IS NOT NULL)                             AS became,
               i.received_at                                  AS at
          FROM inquiries i
          LEFT JOIN households h
            ON h.id = i.household_id AND h.deleted_at IS NULL
         WHERE i.partner_id IS NOT NULL
        UNION ALL
        -- And what the household record holds, which outlives the enquiry.
        SELECT hh.partner_id, hh.id::text, true, hh.created_at
          FROM households hh
         WHERE hh.partner_id IS NOT NULL AND hh.deleted_at IS NULL
      ) recorded
     GROUP BY partner_id, family
  )`;

export interface AttributionDisagreement {
  inquiryId: string;
  receivedAt: string;
  householdId: string;
  householdName: string;
  /** Who the enquiry says sent them. Null where it says nobody. */
  onEnquiryId: string | null;
  onEnquiryName: string | null;
  /** Who the household record says sent them. Null where it says nobody. */
  onHouseholdId: string | null;
  onHouseholdName: string | null;
}

/**
 * THE TWO COLUMNS, COMPARED. One fact written twice, read back as one question.
 *
 * `inquiries.partner_id` and `households.partner_id` both record which partner sent a
 * family, and nothing stops them disagreeing. They are not redundant — they do different
 * jobs, which is why neither can simply be dropped:
 *
 *  - the enquiry's key is the ACCESS key. `partner_referrals()` (core migration 0012)
 *    selects `WHERE i.partner_id = current_partner()` and nothing else, so that column
 *    alone decides who may read a referral and, past the consent gate, its outcome.
 *  - the household's key is the DURABLE one. It is the record that outlives an enquiry
 *    leaving the queue, and the only attribution a household reached any other way —
 *    a partner who rang rather than filled in a form — can have at all.
 *
 * So they must both exist, and the next best thing to a constraint is that a
 * disagreement cannot go unnoticed: this read is rendered on /partners, the screen that
 * owns referral partners, whenever it returns anything. Every write path in this console
 * now sets both together, which means anything this finds was written from outside it —
 * the public platform, the seed, or somebody's psql — and that is exactly the case a
 * test over our own writes cannot catch.
 *
 * WHAT WOULD BE BETTER AND IS NOT REACHABLE HERE: a constraint trigger in
 * @h-hallows/core's migrations, which is a different repository. Written down rather
 * than described, so it can be lifted into one:
 *
 *   CREATE OR REPLACE FUNCTION assert_one_sender_per_family(h_id uuid) RETURNS void
 *     LANGUAGE plpgsql AS $$
 *   DECLARE bad record;
 *   BEGIN
 *     IF h_id IS NULL THEN RETURN; END IF;
 *     SELECT i.id AS inquiry_id, i.partner_id AS on_enquiry, h.partner_id AS on_household
 *       INTO bad
 *       FROM households h JOIN inquiries i ON i.household_id = h.id
 *      WHERE h.id = h_id AND h.deleted_at IS NULL
 *        AND i.partner_id IS DISTINCT FROM h.partner_id
 *      LIMIT 1;
 *     IF FOUND THEN
 *       RAISE EXCEPTION
 *         'enquiry % was sent by %, household % by % — one sender, two columns',
 *         bad.inquiry_id, coalesce(bad.on_enquiry::text, 'nobody'),
 *         h_id, coalesce(bad.on_household::text, 'nobody')
 *         USING ERRCODE = 'integrity_constraint_violation';
 *     END IF;
 *   END; $$;
 *
 *   -- One per table, DEFERRED, because a transaction legitimately writes the household
 *   -- and the enquiry in either order: convertInquiry inserts the household first and
 *   -- updates the enquiry afterwards, so an immediate trigger would reject the correct
 *   -- sequence. Judged at commit, both orders pass and no disagreement survives one.
 *   CREATE CONSTRAINT TRIGGER inquiries_one_sender_per_family
 *     AFTER INSERT OR UPDATE OF partner_id, household_id ON inquiries
 *     DEFERRABLE INITIALLY DEFERRED
 *     FOR EACH ROW EXECUTE FUNCTION inquiries_one_sender();     -- PERFORM on NEW.household_id
 *   CREATE CONSTRAINT TRIGGER households_one_sender_per_family
 *     AFTER INSERT OR UPDATE OF partner_id ON households
 *     DEFERRABLE INITIALLY DEFERRED
 *     FOR EACH ROW EXECUTE FUNCTION households_one_sender();    -- PERFORM on NEW.id
 *
 * It cannot go in cold. One backfill is safe and one is NOT, and that asymmetry is why
 * this read exists rather than a migration being written blind:
 *
 *   -- Safe: the household record learns what the enquiry already decided. It grants
 *   -- nobody anything, because the enquiry's key is what grants.
 *   UPDATE households h SET partner_id = i.partner_id
 *     FROM inquiries i
 *    WHERE i.household_id = h.id AND h.partner_id IS NULL AND i.partner_id IS NOT NULL;
 *
 * The other direction — copying a household's key onto an enquiry that has none — would
 * hand a partner sight of a referral and its outcome that nobody attached them to. That
 * is an access grant, it belongs to an operator, and `attributionDisagreements()` is how
 * they are shown the list to decide from.
 *
 * The alternative shape, dropping `households.partner_id` and deriving it from the
 * enquiry, does not work: a household can exist with no enquiry behind it at all — the
 * seed has three — and that attribution would have nowhere to live.
 *
 * Both directions are reported. An enquiry naming a partner whose household names
 * nobody is the harmless-looking half, and it is the one that loses the attribution the
 * day the enquiry row is deleted.
 */
export async function attributionDisagreements(
  ctx: AuditContext,
): Promise<AttributionDisagreement[]> {
  const { query } = await getDb();
  const rows = await query<{
    inquiry_id: string; received_at: string; household_id: string; display_name: string;
    on_enquiry_id: string | null; on_enquiry_name: string | null;
    on_household_id: string | null; on_household_name: string | null;
  }>(
    `SELECT i.id AS inquiry_id, i.received_at::text, h.id AS household_id,
            h.display_name,
            i.partner_id AS on_enquiry_id,   pe.name AS on_enquiry_name,
            h.partner_id AS on_household_id, ph.name AS on_household_name
       FROM inquiries i
       JOIN households h ON h.id = i.household_id AND h.deleted_at IS NULL
       LEFT JOIN referral_partners pe ON pe.id = i.partner_id
       LEFT JOIN referral_partners ph ON ph.id = h.partner_id
      /*
       * IS DISTINCT FROM, not <>. Half of these disagreements have a null on one side,
       * and <> is null for those — the comparison would quietly return nothing and the
       * screen would report no disagreement, which is the failure this read exists to
       * prevent happening one layer down.
       */
      WHERE i.partner_id IS DISTINCT FROM h.partner_id
      ORDER BY i.received_at DESC
      LIMIT 50`,
  );

  // Named households, so audited per household — the same rule the § 8 screens follow.
  for (const householdId of new Set(rows.map((r) => r.household_id))) {
    await auditRead(ctx, 'household', householdId,
      { read: 'the partner attribution reconciliation' });
  }

  return rows.map((r) => ({
    inquiryId: r.inquiry_id,
    receivedAt: r.received_at,
    householdId: r.household_id,
    householdName: r.display_name,
    onEnquiryId: r.on_enquiry_id,
    onEnquiryName: r.on_enquiry_name,
    onHouseholdId: r.on_household_id,
    onHouseholdName: r.on_household_name,
  }));
}

export interface PartnerPopulation {
  /**
   * Everybody on the referral-partner list.
   *
   * Unfiltered, and that is a fact about the table rather than an omission:
   * `referral_partners` has no status and no `deleted_at`, so a partner is on the list
   * or is not on it. If either is ever added, this is the single place that has to
   * learn about it.
   */
  partners: number;
  /** Families attributed to one of them by key, each counted once. */
  referrals: number;
  /** Of those, how many are a household on the books now. */
  became: number;
}

/**
 * The partner figures as one read, for every screen that reports one.
 *
 * /partners reports them in its header and /measure reports the referral figure beside
 * its table of typed source labels, so an operator comparing the two screens is
 * comparing one definition with itself. No `AuditContext`: these are three counts and
 * they name nobody, the same as `countUnhandledInquiries`, and the screens that call it
 * audit their own read.
 *
 * The rule that stops a fourth screen computing its own is asserted in
 * tests/partners.test.ts, which forbids `FROM referral_partners` outside this module.
 */
export async function partnerPopulation(): Promise<PartnerPopulation> {
  const { query } = await getDb();
  const [row] = await query<{ partners: string; referrals: string; became: string }>(
    `WITH ${PARTNER_REFERRALS_CTE}
     SELECT (SELECT count(*) FROM referral_partners)::text              AS partners,
            (SELECT count(*) FROM partner_referrals)::text              AS referrals,
            (SELECT count(*) FROM partner_referrals WHERE became)::text AS became`,
  );
  return {
    partners: Number(row!.partners),
    referrals: Number(row!.referrals),
    became: Number(row!.became),
  };
}

export interface PartnerRow {
  id: string;
  name: string;
  org: string | null;
  role: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  createdAt: string;
  /** Families attributed to them, ever, however the attribution was recorded. */
  sent: number;
  /** Of those, how many are a household on the books. */
  became: number;
  /** The most recent one, so a quiet partner is visible as quiet. */
  lastSentAt: string | null;
  /** How many people can sign in on their behalf, and whether any are revoked. */
  accounts: number;
  revokedAccounts: number;
}

export async function listPartners(ctx: AuditContext): Promise<PartnerRow[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; name: string; org: string | null; role: string | null;
    phone: string | null; email: string | null; notes: string | null;
    created_at: string; sent: string; became: string; last_sent_at: string | null;
    accounts: string; revoked_accounts: string;
  }>(
    `WITH ${PARTNER_REFERRALS_CTE}
     SELECT p.id, p.name, p.org, p.role, p.phone, p.email, p.notes, p.created_at::text,
            coalesce(i.sent, 0)::text   AS sent,
            coalesce(i.became, 0)::text AS became,
            /*
             * CALIFORNIA'S DATE, not the server's. This column renders through
             * shortDate(), which reads the leading YYYY-MM-DD off the string, and a
             * timestamptz casts to text in UTC. From late afternoon Pacific onwards
             * that is tomorrow, so a partner who sent a family this evening was dated
             * as having sent it the day after — on the screen whose whole job is to
             * show whether a partner has gone quiet. Nothing caught it because the seed
             * writes no inquiries, so this column was null on every row and the
             * formatting was never once exercised. Fourth instance of this bug in this
             * repository; the other three are named in lib/queries/measure.ts and
             * V1-REVIEW § 2.
             */
            (i.last_sent_at AT TIME ZONE 'America/Los_Angeles')::date::text
              AS last_sent_at,
            coalesce(a.accounts, 0)::text         AS accounts,
            coalesce(a.revoked_accounts, 0)::text AS revoked_accounts
       FROM referral_partners p
       LEFT JOIN (
         /*
          * Aggregated from the shared definition above rather than from inquiries
          * directly. A per-partner count and the screen-level total have to be the same
          * arithmetic over the same rows, or the card and the header disagree — which
          * is the smaller version of the defect this whole query was changed to fix.
          */
         SELECT partner_id,
                count(*)                       AS sent,
                count(*) FILTER (WHERE became) AS became,
                max(sent_at)                   AS last_sent_at
           FROM partner_referrals GROUP BY partner_id
       ) i ON i.partner_id = p.id
       LEFT JOIN (
         SELECT pu.partner_id,
                count(*)                                           AS accounts,
                count(*) FILTER (WHERE u.disabled_at IS NOT NULL)  AS revoked_accounts
           FROM partner_users pu JOIN users u ON u.id = pu.user_id
          GROUP BY pu.partner_id
       ) a ON a.partner_id = p.id
      ORDER BY coalesce(i.sent, 0) DESC, p.name`,
  );

  await auditRead(ctx, 'referral_partner');

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    org: r.org,
    role: r.role,
    phone: r.phone,
    email: r.email,
    notes: r.notes,
    createdAt: r.created_at,
    sent: Number(r.sent),
    became: Number(r.became),
    lastSentAt: r.last_sent_at,
    accounts: Number(r.accounts),
    revokedAccounts: Number(r.revoked_accounts),
  }));
}

export interface AddPartnerInput {
  name: string;
  org?: string;
  role?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export async function addPartner(
  ctx: AuditContext,
  input: AddPartnerInput,
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name.length < 2) throw new PartnerError('Give them a name.');

  const { query } = await getDb();
  const [row] = await query<{ id: string }>(
    `INSERT INTO referral_partners (name, org, role, phone, email, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [name, input.org?.trim() || null, input.role?.trim() || null,
      input.phone?.trim() || null, input.email?.trim() || null, input.notes?.trim() || null],
  );
  if (!row) throw new PartnerError('Could not add them.');

  await audit({
    ...ctx,
    action: 'create',
    entity: 'referral_partner',
    entityId: row.id,
    diff: { name, org: input.org?.trim() || null, role: input.role?.trim() || null },
  });

  return { id: row.id };
}

export interface UnattributedReferral {
  inquiryId: string;
  receivedAt: string;
  contactName: string;
  careType: string | null;
  area: string | null;
  urgency: string | null;
  handled: boolean;
  /** What the sender typed about themselves. Not evidence of who they are. */
  claimedName: string | null;
  claimedOrg: string | null;
  claimedEmail: string | null;
  patientInitials: string | null;
  /** A partner whose recorded email matches what was typed. A suggestion, not a match. */
  suggestedPartnerId: string | null;
  suggestedPartnerName: string | null;
}

/**
 * Partner referrals that belong to nobody yet.
 *
 * A signed-in partner's referral is attributed when it arrives. One sent from the
 * public form is not, and must not be: the email in that form is typed by whoever is
 * filling it in, and `inquiries.partner_id` is what decides who may read the outcome
 * later — so matching on it would let anybody claim another partner's referrals by
 * knowing their address.
 *
 * The match is offered rather than applied. An operator who recognises the name
 * attaches it; the database only suggests where a recorded email is identical.
 */
export async function unattributedReferrals(
  ctx: AuditContext,
): Promise<UnattributedReferral[]> {
  const { query } = await getDb();
  const rows = await query<{
    id: string; received_at: string; name: string; care_type: string | null;
    area: string | null; urgency: string | null; handled: boolean;
    claimed_name: string | null; claimed_org: string | null; claimed_email: string | null;
    initials: string | null; suggested_id: string | null; suggested_name: string | null;
  }>(
    `SELECT i.id, i.received_at::text, i.name, i.care_type::text, i.area,
            i.urgency::text, (i.handled_at IS NOT NULL) AS handled,
            i.referrer ->> 'partnerName'     AS claimed_name,
            i.referrer ->> 'partnerOrg'      AS claimed_org,
            i.referrer ->> 'partnerEmail'    AS claimed_email,
            i.referrer ->> 'patientInitials' AS initials,
            p.id   AS suggested_id,
            p.name AS suggested_name
       FROM inquiries i
       LEFT JOIN referral_partners p
         ON lower(p.email) = lower(i.referrer ->> 'partnerEmail')
      WHERE i.partner_id IS NULL
        AND i.referrer IS NOT NULL
      ORDER BY i.received_at DESC
      LIMIT 50`,
  );

  if (rows.length > 0) await auditRead(ctx, 'unattributed_referral');

  return rows.map((r) => ({
    inquiryId: r.id,
    receivedAt: r.received_at,
    contactName: r.name,
    careType: r.care_type,
    area: r.area,
    urgency: r.urgency,
    handled: r.handled,
    claimedName: r.claimed_name,
    claimedOrg: r.claimed_org,
    claimedEmail: r.claimed_email,
    patientInitials: r.initials,
    suggestedPartnerId: r.suggested_id,
    suggestedPartnerName: r.suggested_name,
  }));
}

/**
 * Attach a referral to the partner who sent it.
 *
 * This grants a read: `partner_referrals()` is scoped by `partner_id`, so from here on
 * that partner can see this referral and — once the household consents — its outcome.
 * Set once, and the audit row records who decided.
 *
 * BOTH COLUMNS, IN ONE TRANSACTION. This wrote the enquiry's key alone, and the list it
 * is called from shows referrals that have already been handled — "already handled" is
 * printed beside them on /partners. So attaching one that had become a household left
 * the enquiry naming a partner and the household naming nobody: one fact, two columns,
 * written half an hour apart and never reconciled. The household record is the durable
 * one, so the attribution would have been lost the day that enquiry row went.
 *
 * The household is locked and read before either write. Where it already names a
 * DIFFERENT partner this refuses rather than picking a winner: two people have recorded
 * two different senders, and a query is not the thing that should decide between them.
 */
export async function attachReferralToPartner(
  ctx: AuditContext,
  inquiryId: string,
  partnerId: string,
): Promise<{ partnerName: string; householdAttributed: boolean }> {
  const handle = await getDb();
  return handle.transaction(async (tx) => {
    const [inquiry] = await tx.query<{
      partner_id: string | null; name: string; household_id: string | null;
    }>(
      `SELECT partner_id, name, household_id FROM inquiries WHERE id = $1`, [inquiryId],
    );
    if (!inquiry) throw new PartnerError('That referral does not exist.');
    if (inquiry.partner_id) {
      throw new PartnerError('That referral is already attached to a partner.');
    }

    const [partner] = await tx.query<{ name: string }>(
      `SELECT name FROM referral_partners WHERE id = $1`, [partnerId],
    );
    if (!partner) throw new PartnerError('That partner does not exist.');

    /*
     * `FOR UPDATE` for the same reason `lockUnhandled` takes it in intake: without it,
     * two operators attaching two partners to two enquiries of the same household would
     * both read "nobody recorded" and the second write would silently replace the first.
     */
    const [household] = inquiry.household_id
      ? await tx.query<{ id: string; partner_id: string | null; display_name: string }>(
        `SELECT id, partner_id, display_name FROM households WHERE id = $1 FOR UPDATE`,
        [inquiry.household_id],
      )
      : [];

    if (household?.partner_id && household.partner_id !== partnerId) {
      const [other] = await tx.query<{ name: string }>(
        `SELECT name FROM referral_partners WHERE id = $1`, [household.partner_id],
      );
      throw new PartnerError(
        `The household this became — ${household.display_name} — is already recorded as `
        + `sent by ${other?.name ?? 'another partner'}. Correct the household record `
        + 'first: attaching this would leave the enquiry and the household naming two '
        + 'different senders, and only one of them decides who may read the outcome.',
      );
    }

    await tx.query(
      `UPDATE inquiries SET partner_id = $2 WHERE id = $1 AND partner_id IS NULL`,
      [inquiryId, partnerId],
    );

    const householdAttributed = Boolean(household) && !household!.partner_id;
    if (householdAttributed) {
      await tx.query(
        `UPDATE households SET partner_id = $2 WHERE id = $1 AND partner_id IS NULL`,
        [household!.id, partnerId],
      );
    }

    await audit({
      ...ctx,
      action: 'update',
      entity: 'inquiry',
      entityId: inquiryId,
      diff: {
        partnerId: { from: null, to: partnerId },
        partnerName: partner.name,
        // What it grants, said in the log rather than inferred from it later.
        grants: 'this partner may now see this referral and, with household consent, its outcome',
        // And what else moved with it, so the two columns have one history between them.
        householdAttributed: householdAttributed ? household!.id : null,
      },
    }, tx);

    return { partnerName: partner.name, householdAttributed };
  });
}

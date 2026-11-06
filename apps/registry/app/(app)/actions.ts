'use server';

/**
 * Server actions. Every mutation the operator can perform goes through one of these, and
 * every one takes the audited operator context.
 *
 * Deliberately absent, and not to be added:
 *  - anything that ends a household–provider relationship on the registry's behalf (I4)
 *  - anything that computes, suggests or caps a provider's rate (I5)
 *  - anything that records task completion or duty verification (I2)
 *  - anything that routes feedback into a corrective workflow (I7)
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { mailConfigured, sendMail } from '@h-hallows/core/mail';
import { requireOperator } from '@/lib/operator';
import { addNote, logCall } from '@/lib/queries/cases';
import { saveShortlistToTimeline } from '@/lib/queries/match';
import {
  BenchError, publishBench, resolveRequest, withdrawBench,
} from '@/lib/queries/bench';
import {
  AccessError, grantPortalAccess, isPortalSubjectKind, reissuePortalLink,
  restorePortalAccess, revokePortalAccess, type PortalSubjectKind,
} from '@/lib/domain/portalAccess';
import { addPartner, PartnerError } from '@/lib/queries/partners';
import {
  DocumentError, fileDocument, redactDocument, setDocumentVisibility,
  type DocumentKind, type Subject,
} from '@/lib/queries/documents';
import { setProviderReferralStatus, upsertCredential } from '@/lib/queries/providers';
import {
  endEngagement, makeReferral, markWrittenStatementSent, recordReferralOutcome,
  ReferralError,
} from '@/lib/domain/referral';
import {
  acceptSubmission, rejectSubmission, SubmissionError,
} from '@/lib/domain/credentialSubmissions';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date');

export interface ActionState {
  error?: string;
  ok?: string;
  /**
   * Something the operator has to copy out of the screen, shown once.
   *
   * There is no mail provider, so an issued sign-in link is handed back here rather than
   * sent. It is never written to the log or the audit diff: only its hash is stored, and
   * this is the only moment it exists in readable form.
   */
  copy?: { label: string; text: string };
}

function fail(message: string): ActionState {
  return { error: message };
}

function messageOf(err: unknown): string {
  if (err instanceof ReferralError) return err.message;
  if (err instanceof BenchError) return err.message;
  if (err instanceof AccessError) return err.message;
  if (err instanceof PartnerError) return err.message;
  if (err instanceof DocumentError) return err.message;
  if (err instanceof SubmissionError) return err.message;
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? 'Check the form.';
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

export async function logCallAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const caseId = uuid.parse(form.get('caseId'));
    const body = z.string().trim().min(3, 'Write what was said.').parse(form.get('body'));
    await logCall(ctx, caseId, body);
    revalidatePath(`/cases/${caseId}`);
    revalidatePath('/today');
    return { ok: 'Call logged.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

export async function addNoteAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const caseId = uuid.parse(form.get('caseId'));
    const body = z.string().trim().min(3, 'Write the note.').parse(form.get('body'));
    await addNote(ctx, caseId, body);
    revalidatePath(`/cases/${caseId}`);
    return { ok: 'Note added.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

const CREDENTIAL_TYPES = [
  'rn_license', 'lvn_license', 'cna_cert', 'hca_registry', 'live_scan', 'tb_clearance',
  'cpr_bls', 'auto_insurance', 'drivers_license', 'immunization', 'other',
] as const;

export async function upsertCredentialAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const parsed = z.object({
      providerId: uuid,
      type: z.enum(CREDENTIAL_TYPES),
      identifier: z.string().trim().optional(),
      issuedOn: isoDate.optional().or(z.literal('')),
      expiresOn: isoDate.optional().or(z.literal('')),
      verifiedOn: isoDate,
      verificationSource: z.string().trim().min(3, 'Say how it was verified.'),
      notes: z.string().trim().optional(),
      // § 1812.528. Shown by the form only for a nursing licence, and required there.
      inspectedExpiryNoted: isoDate.optional().or(z.literal('')),
      inspectedOn: isoDate.optional().or(z.literal('')),
    }).parse({
      providerId: form.get('providerId'),
      type: form.get('type'),
      identifier: form.get('identifier') ?? undefined,
      issuedOn: form.get('issuedOn') ?? '',
      expiresOn: form.get('expiresOn') ?? '',
      verifiedOn: form.get('verifiedOn'),
      verificationSource: form.get('verificationSource'),
      notes: form.get('notes') ?? undefined,
      inspectedExpiryNoted: form.get('inspectedExpiryNoted') ?? '',
      inspectedOn: form.get('inspectedOn') ?? '',
    });

    const result = await upsertCredential(ctx, {
      providerId: parsed.providerId,
      type: parsed.type,
      identifier: parsed.identifier || null,
      issuedOn: parsed.issuedOn || null,
      expiresOn: parsed.expiresOn || null,
      verifiedOn: parsed.verifiedOn,
      verificationSource: parsed.verificationSource,
      notes: parsed.notes || null,
      inspection: parsed.inspectedExpiryNoted
        ? { expiryNoted: parsed.inspectedExpiryNoted, on: parsed.inspectedOn || null }
        : null,
    });

    revalidatePath(`/roster/${parsed.providerId}`);
    revalidatePath('/roster');
    revalidatePath('/compliance');
    revalidatePath('/today');
    return { ok: result.renewed ? 'Credential renewed.' : 'Credential recorded.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/**
 * I4: forward-only. `do_not_refer` stops future referrals and touches no live engagement.
 */
export async function setReferralStatusAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const providerId = uuid.parse(form.get('providerId'));
    const status = z.enum(['active', 'inactive', 'do_not_refer']).parse(form.get('status'));
    const note = z.string().trim().min(3, 'Record why.').parse(form.get('note'));
    await setProviderReferralStatus(ctx, providerId, status, note);
    revalidatePath(`/roster/${providerId}`);
    revalidatePath('/roster');
    return { ok: 'Referral status updated. No engagement was changed.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

export async function saveShortlistAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const caseId = uuid.parse(form.get('caseId'));
    const providerIds = form.getAll('providerId').map((v) => uuid.parse(v));
    await saveShortlistToTimeline(ctx, caseId, providerIds);
    revalidatePath(`/cases/${caseId}`);
    revalidatePath(`/match/${caseId}`);
    return { ok: `Shortlist of ${providerIds.length} saved to the timeline.` };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/**
 * Put the bench in front of the household. The one action in this file whose effect is
 * visible outside the console.
 *
 * The screen runs again inside the transaction, so what the operator saw a minute ago
 * does not decide who reaches a client. See publishBench.
 */
export async function publishBenchAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const caseId = uuid.parse(form.get('caseId'));
    const providerIds = form.getAll('providerId').map((v) => uuid.parse(v));
    const note = z.string().trim().max(500, 'Keep the note short.').optional()
      .parse(form.get('note') || undefined);
    const result = await publishBench(ctx, { caseId, providerIds, note });
    revalidatePath(`/cases/${caseId}`);
    revalidatePath(`/match/${caseId}`);
    revalidatePath('/today');
    return {
      ok: result.replaced > 0
        ? `${result.count} put in front of the household. The previous bench was withdrawn.`
        : `${result.count} put in front of the household.`,
    };
  } catch (err) {
    return fail(messageOf(err));
  }
}

export async function withdrawBenchAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const shortlistId = uuid.parse(form.get('shortlistId'));
    const caseId = uuid.parse(form.get('caseId'));
    const reason = z.string().trim().min(3, 'Record why.').parse(form.get('reason'));
    await withdrawBench(ctx, shortlistId, reason);
    revalidatePath(`/cases/${caseId}`);
    revalidatePath(`/match/${caseId}`);
    return { ok: 'Bench withdrawn. The household no longer sees it.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/**
 * Close a request that is not becoming a referral. The two outcomes record what happened,
 * and neither is a judgment about the provider — nothing here reaches their record.
 */
export async function resolveRequestAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const requestId = uuid.parse(form.get('requestId'));
    const outcome = z.enum(['declined_by_household', 'withdrawn']).parse(form.get('outcome'));
    const note = z.string().trim().min(3, 'Record what was said.').parse(form.get('note'));
    await resolveRequest(ctx, requestId, outcome, note);
    revalidatePath('/requests');
    revalidatePath('/today');
    const caseId = form.get('caseId');
    if (typeof caseId === 'string' && caseId) revalidatePath(`/cases/${caseId}`);
    return {
      ok: outcome === 'declined_by_household'
        ? 'Recorded: the household decided against it.'
        : 'Recorded: not going ahead.',
    };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/**
 * Portal access. The four actions below are the only way an address gains or loses the
 * ability to sign in to a portal, and each one records who did it.
 *
 * The issued link comes back in `copy` and goes nowhere else — not to the log, not to the
 * audit diff. Until a mail provider is wired, the operator sends it.
 */
const DOCUMENT_KIND = z.enum([
  'credential', 'registry_agreement', 'written_notice', 'written_statement',
  'nurse_disclosure', 'correspondence', 'other',
]);

function documentSubject(form: FormData): Subject {
  const kind = z.enum(['provider', 'household', 'case']).parse(form.get('subjectKind'));
  return { kind, id: uuid.parse(form.get('subjectId')) } as Subject;
}

function revalidateDocumentSubject(subject: Subject): void {
  if (subject.kind === 'provider') revalidatePath(`/roster/${subject.id}`);
  if (subject.kind === 'case') revalidatePath(`/cases/${subject.id}`);
  if (subject.kind === 'household') revalidatePath('/cases');
}

/**
 * File a document.
 *
 * `visible_to_subject` is an explicit, un-prechecked box and defaults to off: filing
 * something is not the same as showing it to the family, and the operator's diligence
 * record is not theirs to read (I12).
 */
export async function fileDocumentAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const subject = documentSubject(form);
    const kind = DOCUMENT_KIND.parse(form.get('kind')) as DocumentKind;
    const note = z.string().trim().max(300).optional().parse(form.get('note') || undefined);
    const credentialId = form.get('credentialId')
      ? uuid.parse(form.get('credentialId'))
      : undefined;

    const upload = form.get('file');
    if (!(upload instanceof File) || upload.size === 0) {
      return fail('Choose a file.');
    }
    const bytes = Buffer.from(await upload.arrayBuffer());

    const result = await fileDocument(ctx, {
      subject,
      kind,
      filename: upload.name,
      contentType: upload.type,
      bytes,
      note,
      credentialId,
      visibleToSubject: form.get('visibleToSubject') === 'yes',
    });

    revalidateDocumentSubject(subject);
    return {
      ok: result.duplicateOf
        ? 'Filed. The same file is already on this record — both are kept.'
        : 'Filed.',
      copy: {
        label: `SHA-256 of ${upload.name}`,
        text: result.sha256Hex,
      },
    };
  } catch (err) {
    return fail(messageOf(err));
  }
}

export async function setDocumentVisibilityAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const subject = documentSubject(form);
    const documentId = uuid.parse(form.get('documentId'));
    const visible = form.get('visible') === 'yes';
    await setDocumentVisibility(ctx, documentId, visible);
    revalidateDocumentSubject(subject);
    return { ok: visible ? 'They can see it now.' : 'No longer shared with them.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/**
 * Drop the bytes and keep the record. The only destructive act in this console, and it
 * exists because append-only cannot un-leak a document filed against the wrong family.
 */
export async function redactDocumentAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const subject = documentSubject(form);
    const documentId = uuid.parse(form.get('documentId'));
    const reason = z.string().trim().min(3, 'Record why.').parse(form.get('reason'));
    await redactDocument(ctx, documentId, reason);
    revalidateDocumentSubject(subject);
    return { ok: 'Redacted. The file is gone; the record that it existed is not.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/**
 * Add a referral partner. A name, an organisation and a way to reach them.
 *
 * There is deliberately no amount, rate, percentage or balance in this form, and none
 * should be added: § 1812.531 forbids a nurses' registry from splitting a fee, and what
 * a partner may be compensated for at all is COUNSEL.md question 3.
 */
export async function addPartnerAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const parsed = z.object({
      name: z.string().trim().min(2, 'Give them a name.'),
      org: z.string().trim().optional(),
      role: z.string().trim().optional(),
      phone: z.string().trim().optional(),
      email: z.string().trim().email('That is not an email address.').optional(),
      notes: z.string().trim().optional(),
    }).parse({
      name: form.get('name'),
      org: form.get('org') || undefined,
      role: form.get('role') || undefined,
      phone: form.get('phone') || undefined,
      email: form.get('email') || undefined,
      notes: form.get('notes') || undefined,
    });
    await addPartner(ctx, parsed);
    revalidatePath('/partners');
    return { ok: `${parsed.name} added. Give them access when you are ready.` };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/**
 * Send the link, and say plainly which happened.
 *
 * The link is shown on screen whichever way this goes. The operator issued it
 * deliberately and may want to send it themselves with a sentence of their own — and
 * with no provider configured, handing it over is the only way it reaches anybody.
 *
 * Unlike the public sign-in form, saying "we could not send it" here leaks nothing: the
 * operator is authenticated, chose the address, and is the person who has to do
 * something about it.
 */
async function mailLink(
  kind: PortalSubjectKind, email: string, url: string, expiresAt: string,
): Promise<string> {
  if (!mailConfigured()) return 'No mail provider is configured, so send them this link.';

  const what = kind === 'partner' ? 'the referral screen' : 'your own screen';
  const outcome = await sendMail({
    to: email,
    subject: 'Your sign-in link',
    text:
      `Here is your link to ${what}.\n\n${url}\n\n`
      + `It works once and expires on ${expiresAt.slice(0, 10)}. `
      + 'If you were not expecting this, nothing has happened and you can ignore it.',
  });

  return outcome.delivered
    ? `Sent to ${email}.`
    : `It could not be sent (${outcome.reason}) — send them this link.`;
}

function subjectKind(form: FormData): PortalSubjectKind {
  const kind = form.get('kind');
  if (!isPortalSubjectKind(kind)) throw new AccessError('Unknown portal.');
  return kind;
}

function revalidateSubject(kind: PortalSubjectKind, subjectId: string | null): void {
  if (kind === 'household' && subjectId) revalidatePath(`/cases/${subjectId}`);
  if (kind === 'provider' && subjectId) revalidatePath(`/roster/${subjectId}`);
  if (kind === 'partner') revalidatePath('/partners');
}

export async function grantAccessAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const kind = subjectKind(form);
    const subjectId = uuid.parse(form.get('subjectId'));
    const email = z.string().trim().email('That is not an email address.')
      .parse(form.get('email'));
    const displayName = z.string().trim().min(2, 'Give the person a name.')
      .parse(form.get('displayName'));

    const result = await grantPortalAccess(ctx, { kind, subjectId, email, displayName });
    revalidateSubject(kind, subjectId);
    const sent = await mailLink(kind, email, result.url, result.expiresAt);
    return {
      ok: (result.existing
        ? `A new link for ${email}. The previous one no longer works.`
        : `${email} now has access.`) + ' ' + sent,
      copy: {
        label: `Sign-in link for ${email} — works once, expires ${result.expiresAt.slice(0, 10)}`,
        text: result.url,
      },
    };
  } catch (err) {
    return fail(messageOf(err));
  }
}

export async function reissueLinkAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const userId = uuid.parse(form.get('userId'));
    const result = await reissuePortalLink(ctx, userId);
    const sent = await mailLink(result.kind, result.email, result.url, result.expiresAt);
    return {
      ok: `New link issued. The previous one no longer works. ${sent}`,
      copy: {
        label: `Sign-in link — works once, expires ${result.expiresAt.slice(0, 10)}`,
        text: result.url,
      },
    };
  } catch (err) {
    return fail(messageOf(err));
  }
}

export async function revokeAccessAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const kind = subjectKind(form);
    const userId = uuid.parse(form.get('userId'));
    const reason = z.string().trim().min(3, 'Record why.').parse(form.get('reason'));
    await revokePortalAccess(ctx, userId, reason);
    revalidateSubject(kind, (form.get('subjectId') as string | null) ?? null);
    return { ok: 'Access withdrawn. Any open session is already gone.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

export async function restoreAccessAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const kind = subjectKind(form);
    const userId = uuid.parse(form.get('userId'));
    const reason = z.string().trim().min(3, 'Record why.').parse(form.get('reason'));
    await restorePortalAccess(ctx, userId, reason);
    revalidateSubject(kind, (form.get('subjectId') as string | null) ?? null);
    return { ok: 'Access restored. Issue a link when you are ready.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/**
 * The referral. The spoken disclosure confirmation is a required, un-prechecked checkbox
 * and the recipient's name is required. There is no skip path and no "record later".
 */
export async function makeReferralAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { operator, ctx } = await requireOperator();
  try {
    const parsed = z.object({
      caseId: uuid,
      providerId: uuid,
      disclosedTo: z.string().trim().min(2, 'Name the person the disclosure was given to.'),
      method: z.enum(['phone', 'in_person']),
      confirm: z.literal('yes', {
        errorMap: () => ({ message: 'Confirm that the spoken disclosure was given.' }),
      }),
      note: z.string().trim().optional(),
      fromRequestId: uuid.optional(),
    }).parse({
      caseId: form.get('caseId'),
      providerId: form.get('providerId'),
      disclosedTo: form.get('disclosedTo'),
      method: form.get('method'),
      confirm: form.get('confirm'),
      note: form.get('note') ?? undefined,
      fromRequestId: form.get('fromRequestId') || undefined,
    });

    const result = await makeReferral(ctx, {
      caseId: parsed.caseId,
      providerId: parsed.providerId,
      disclosedTo: parsed.disclosedTo,
      disclosedBy: operator.displayName,
      method: parsed.method,
      spokenDisclosureGiven: true,
      note: parsed.note,
      fromRequestId: parsed.fromRequestId,
    });

    revalidatePath(`/cases/${parsed.caseId}`);
    revalidatePath(`/match/${parsed.caseId}`);
    revalidatePath('/today');
    revalidatePath('/requests');
    revalidatePath('/compliance');
    return { ok: `Referral recorded. Written statement due ${result.writtenDueOn}.` };
  } catch (err) {
    return fail(messageOf(err));
  }
}

export async function markWrittenSentAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { operator, ctx } = await requireOperator();
  try {
    const parsed = z.object({
      disclosureId: uuid,
      sentOn: isoDate,
      method: z.string().trim().min(2, 'Say how it was sent.'),
      caseId: uuid,
    }).parse({
      disclosureId: form.get('disclosureId'),
      sentOn: form.get('sentOn'),
      method: form.get('method'),
      caseId: form.get('caseId'),
    });

    const upload = form.get('sentStatement');
    const sentStatement = upload instanceof File && upload.size > 0
      ? {
        filename: upload.name,
        contentType: upload.type,
        bytes: Buffer.from(await upload.arrayBuffer()),
      }
      : undefined;

    await markWrittenStatementSent(
      ctx, parsed.disclosureId, parsed.sentOn, parsed.method, operator.displayName,
      sentStatement,
    );
    revalidatePath(`/cases/${parsed.caseId}`);
    revalidatePath('/today');
    revalidatePath('/compliance');
    return {
      ok: sentStatement
        ? 'Recorded as sent, with a copy of what went out.'
        : 'Written statement recorded as sent. No copy was attached, so the record '
          + 'says it was sent and cannot produce it.',
    };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/**
 * What came of a referral. § 8: this is the start of the engagement clock, and the only
 * thing that sets cases.primary_provider_id.
 *
 * I4: every option is something the household or the provider did. There is no outcome
 * here for the registry ending a relationship, and adding one would be an invariant
 * change, not a new enum member.
 */
const REFERRAL_OUTCOMES = [
  'engaged', 'declined_by_household', 'declined_by_provider', 'no_response',
] as const;

export async function recordReferralOutcomeAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { operator, ctx } = await requireOperator();
  try {
    const parsed = z.object({
      referralId: uuid,
      caseId: uuid,
      outcome: z.enum(REFERRAL_OUTCOMES, {
        errorMap: () => ({ message: 'Choose what came of the referral.' }),
      }),
      note: z.string().trim().optional(),
    }).parse({
      referralId: form.get('referralId'),
      caseId: form.get('caseId'),
      outcome: form.get('outcome'),
      note: form.get('note') ?? undefined,
    });

    const result = await recordReferralOutcome(ctx, {
      referralId: parsed.referralId,
      outcome: parsed.outcome,
      note: parsed.note,
      actor: operator.displayName,
    });

    revalidatePath(`/cases/${parsed.caseId}`);
    revalidatePath('/cases');
    revalidatePath(`/roster/${result.providerId}`);
    revalidatePath('/roster');
    revalidatePath('/today');
    return {
      ok: result.engaged
        ? 'Engagement recorded. The provider is now this case\u2019s primary.'
        : 'Outcome recorded. No engagement was started.',
    };
  } catch (err) {
    return fail(messageOf(err));
  }
}

const END_REASONS = [
  'moved_to_direct_arrangement', 'care_no_longer_needed', 'hospitalized',
  'moved_to_facility', 'deceased', 'cost', 'household_dissatisfied',
  'provider_unavailable', 'moved_to_another_agency', 'other',
] as const;

/**
 * I4: only the household ending the engagement, the provider declining, or a mutual end.
 * § 8: the reason comes from a fixed list and is required, because as free text it would
 * be left blank and the leakage number would not exist.
 */
export async function endEngagementAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { operator, ctx } = await requireOperator();
  try {
    const parsed = z.object({
      caseId: uuid,
      endedBy: z.enum(['household', 'provider', 'mutual']),
      endReason: z.enum(END_REASONS),
      endedOn: isoDate,
      note: z.string().trim().optional(),
    }).parse({
      caseId: form.get('caseId'),
      endedBy: form.get('endedBy'),
      endReason: form.get('endReason'),
      endedOn: form.get('endedOn'),
      note: form.get('note') ?? undefined,
    });

    await endEngagement(ctx, { ...parsed, actor: operator.displayName });
    revalidatePath(`/cases/${parsed.caseId}`);
    revalidatePath('/cases');
    revalidatePath('/today');
    return { ok: 'Engagement recorded as ended.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/**
 * Reviewing a credential submission. Migration 0008.
 *
 * Note what this form does NOT do: it takes no default from the submission. The expiry
 * and the verification source are typed by the operator from what they checked against
 * the issuing body, and `identifier` is re-keyed rather than carried over. A provider's
 * assertion about their own document is not evidence — prefilling these would give the
 * provider back, through the form, the write that 0008 took away from them.
 */
export async function acceptSubmissionAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const parsed = z.object({
      submissionId: uuid,
      identifier: z.string().trim().optional(),
      issuedOn: isoDate.optional().or(z.literal('')),
      expiresOn: isoDate.optional().or(z.literal('')),
      verifiedOn: isoDate,
      verificationSource: z.string().trim().min(3, 'Say how it was verified.'),
      reviewNote: z.string().trim().optional(),
      // § 1812.528. Present on the form only for a nursing licence, where the
      // `nurse_license_inspected` CHECK makes it mandatory.
      inspectedExpiryNoted: isoDate.optional().or(z.literal('')),
      inspectedOn: isoDate.optional().or(z.literal('')),
    }).parse({
      submissionId: form.get('submissionId'),
      identifier: form.get('identifier') ?? undefined,
      issuedOn: form.get('issuedOn') ?? '',
      expiresOn: form.get('expiresOn') ?? '',
      verifiedOn: form.get('verifiedOn'),
      verificationSource: form.get('verificationSource'),
      reviewNote: form.get('reviewNote') ?? undefined,
      inspectedExpiryNoted: form.get('inspectedExpiryNoted') ?? '',
      inspectedOn: form.get('inspectedOn') ?? '',
    });

    const result = await acceptSubmission(ctx, {
      submissionId: parsed.submissionId,
      identifier: parsed.identifier || null,
      issuedOn: parsed.issuedOn || null,
      expiresOn: parsed.expiresOn || null,
      verifiedOn: parsed.verifiedOn,
      verificationSource: parsed.verificationSource,
      reviewNote: parsed.reviewNote || null,
      inspection: parsed.inspectedExpiryNoted
        ? { expiryNoted: parsed.inspectedExpiryNoted, on: parsed.inspectedOn || null }
        : null,
    });

    revalidatePath('/submissions');
    revalidatePath(`/roster/${result.providerId}`);
    revalidatePath('/roster');
    revalidatePath('/compliance');
    revalidatePath('/today');
    return {
      ok: result.renewed
        ? 'Accepted. The credential was renewed from what you verified.'
        : 'Accepted. The credential was recorded from what you verified.',
    };
  } catch (err) {
    return fail(messageOf(err));
  }
}

/** Rejecting writes no credential. Nothing the provider sent changes their standing. */
export async function rejectSubmissionAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireOperator();
  try {
    const parsed = z.object({
      submissionId: uuid,
      reviewNote: z.string().trim().min(3, 'Record why it was not accepted.'),
    }).parse({
      submissionId: form.get('submissionId'),
      reviewNote: form.get('reviewNote'),
    });

    const result = await rejectSubmission(ctx, parsed);

    revalidatePath('/submissions');
    revalidatePath(`/roster/${result.providerId}`);
    return { ok: 'Rejected. No credential was recorded.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

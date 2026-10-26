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
import { requireOperator } from '@/lib/operator';
import { addNote, logCall } from '@/lib/queries/cases';
import { saveShortlistToTimeline } from '@/lib/queries/match';
import { setProviderReferralStatus, upsertCredential } from '@/lib/queries/providers';
import {
  endEngagement, makeReferral, markWrittenStatementSent, ReferralError,
} from '@/lib/domain/referral';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date');

export interface ActionState { error?: string; ok?: string }

function fail(message: string): ActionState {
  return { error: message };
}

function messageOf(err: unknown): string {
  if (err instanceof ReferralError) return err.message;
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
    }).parse({
      providerId: form.get('providerId'),
      type: form.get('type'),
      identifier: form.get('identifier') ?? undefined,
      issuedOn: form.get('issuedOn') ?? '',
      expiresOn: form.get('expiresOn') ?? '',
      verifiedOn: form.get('verifiedOn'),
      verificationSource: form.get('verificationSource'),
      notes: form.get('notes') ?? undefined,
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
 * The referral. The spoken disclosure confirmation is a required, un-prechecked checkbox
 * and the recipient's name is required. There is no skip path and no "record later".
 */
export async function makeReferralAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { operator, ctx } = await requireOperator();
  void ctx;
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
    }).parse({
      caseId: form.get('caseId'),
      providerId: form.get('providerId'),
      disclosedTo: form.get('disclosedTo'),
      method: form.get('method'),
      confirm: form.get('confirm'),
      note: form.get('note') ?? undefined,
    });

    const result = await makeReferral({
      caseId: parsed.caseId,
      providerId: parsed.providerId,
      disclosedTo: parsed.disclosedTo,
      disclosedBy: operator.displayName,
      method: parsed.method,
      spokenDisclosureGiven: true,
      note: parsed.note,
    });

    revalidatePath(`/cases/${parsed.caseId}`);
    revalidatePath(`/match/${parsed.caseId}`);
    revalidatePath('/today');
    revalidatePath('/compliance');
    return { ok: `Referral recorded. Written statement due ${result.writtenDueOn}.` };
  } catch (err) {
    return fail(messageOf(err));
  }
}

export async function markWrittenSentAction(
  _prev: ActionState | undefined, form: FormData,
): Promise<ActionState> {
  const { operator } = await requireOperator();
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

    await markWrittenStatementSent(
      parsed.disclosureId, parsed.sentOn, parsed.method, operator.displayName,
    );
    revalidatePath(`/cases/${parsed.caseId}`);
    revalidatePath('/today');
    revalidatePath('/compliance');
    return { ok: 'Written statement recorded as sent.' };
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
  const { operator } = await requireOperator();
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

    await endEngagement({ ...parsed, actor: operator.displayName });
    revalidatePath(`/cases/${parsed.caseId}`);
    revalidatePath('/cases');
    revalidatePath('/today');
    return { ok: 'Engagement recorded as ended.' };
  } catch (err) {
    return fail(messageOf(err));
  }
}

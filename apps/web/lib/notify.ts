/**
 * Operator notifications. Spec § 7, transactional only — no marketing, no sequences.
 *
 * THE RULE THAT SHAPES THIS: no provider name, household name, care recipient name,
 * address or clinical detail in a subject or body. Email is not a confidential channel
 * and this clientele is discretion-first, so the message says something is ready and the
 * console says what. It also keeps CCN clear of whether an unencrypted email carrying
 * care details is defensible.
 *
 * No mail provider is wired yet. The row is written regardless, because a notification
 * that exists only as a log line is one that was never sent.
 */
import { getDb } from '@ccn/core/db';

export type NotificationKind =
  | 'inquiry' | 'provider_application' | 'partner_referral' | 'shortlist_request'
  | 'shortlist_published' | 'written_statement_due' | 'nurse_disclosure_outstanding'
  | 'credential_expiring' | 'portal_invite';

export type Urgency = 'discharge' | 'same_day' | 'next_day' | 'routine';

export interface Notification {
  kind: NotificationKind;
  urgency?: Urgency;
  /** Says that something arrived. Never what, or whose. */
  subject: string;
  body: string;
  /** Everything the console needs. Never reaches an inbox. */
  payload?: Record<string, unknown>;
}

/** Terms that must never appear in a subject or body. Asserted in a test, not just here. */
const IDENTIFYING_KEYS = ['name', 'address', 'phone', 'email', 'diagnosis', 'patient'];

export async function notifyOperator(n: Notification): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    for (const key of IDENTIFYING_KEYS) {
      if (`${n.subject} ${n.body}`.toLowerCase().includes(key)) {
        console.warn(
          `[notify] "${key}" appears in a notification subject or body. Spec § 7 keeps `
          + 'identifying detail out of the message and in the console.',
        );
      }
    }
  }

  try {
    const { query } = await getDb();
    await query(
      `INSERT INTO operator_notifications (kind, urgency, subject, body, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [n.kind, n.urgency ?? null, n.subject, n.body, JSON.stringify(n.payload ?? {})],
    );
  } catch (err) {
    // The submission is already recorded. Losing the notification is bad; losing the
    // enquiry because the notification failed would be worse.
    console.error('[notify] could not queue', n.kind, err);
  }
}

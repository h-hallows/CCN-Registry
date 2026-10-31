/**
 * The partner referral form. No account needed for a first referral — spec § 11.
 *
 * Writes to `inquiries` with the partner block in `referrer`. The person we will call
 * is the family contact; the partner's own details are recorded so the acknowledgement
 * can reach a named person.
 */
import type { NextRequest } from 'next/server';
import { PartnerReferralSchema } from '@/lib/schemas/intake';
import { recordPartnerReferral } from '@/lib/intake';
import { rateLimit } from '@/lib/rateLimit';
import { notifyOperator } from '@/lib/notify';
import { accepted, failed, limited, readBody, rejected, silentlyDropped } from '@/lib/intakeResponse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  if (await rateLimit(request, { key: 'refer', max: 10, windowSec: 600 })) return limited();

  const parsed = PartnerReferralSchema.safeParse(await readBody(request));
  if (!parsed.success) return rejected(parsed.error);
  if (parsed.data.honeypot) return silentlyDropped();

  let reference: string;
  try {
    reference = await recordPartnerReferral(parsed.data);
  } catch (err) {
    console.error('[refer] could not record', err);
    return failed();
  }

  await notifyOperator({
    kind: 'partner_referral',
    urgency: parsed.data.urgency,
    subject: `Partner referral (${parsed.data.urgency.replace('_', ' ')})`,
    body: 'A referral has arrived from a partner. Open the console to see it.',
    payload: {
      inquiryId: reference,
      partnerRole: parsed.data.partnerRole,
      urgency: parsed.data.urgency,
    },
  });

  return accepted(
    parsed.data.urgency === 'discharge' || parsed.data.urgency === 'same_day'
      ? 'Received. We will call them today and come back to you with who we spoke to.'
      : 'Received. We will call them and come back to you with who we spoke to.',
    reference,
  );
}

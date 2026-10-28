/**
 * Architecture spec § 6.1 — the partner referral form, which needs no account.
 *
 * Writes to `inquiries` with `partner_id` set, so a partner's first referral is as easy
 * as a phone call and still lands as an attributable record.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { inquirySchema, recordInquiry } from '@/lib/intake';
import { readForm, accepted, rejected, failed } from '@/lib/intakeResponse';

export const dynamic = 'force-dynamic';

const partnerReferralSchema = inquirySchema.innerType().extend({
  partnerId: z.string().uuid('That referral link is not valid.'),
});

export async function POST(request: NextRequest): Promise<Response> {
  const parsed = partnerReferralSchema.safeParse(await readForm(request));
  if (!parsed.success) return rejected(parsed.error);

  try {
    await recordInquiry(parsed.data);
  } catch (err) {
    console.error('[refer] could not record', err);
    return failed();
  }
  return accepted('Received. We will call them today.');
}

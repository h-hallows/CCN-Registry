/** The household enquiry form. Writes to `inquiries` only. Spec § 3.2. */
import type { NextRequest } from 'next/server';
import { CONFIRMATION, InquirySchema } from '@/lib/schemas/intake';
import { recordInquiry } from '@/lib/intake';
import { rateLimit } from '@/lib/rateLimit';
import { notifyOperator } from '@/lib/notify';
import { accepted, failed, limited, readBody, rejected, silentlyDropped } from '@/lib/intakeResponse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  if (await rateLimit(request, { key: 'inquiry', max: 5, windowSec: 600 })) return limited();

  const parsed = InquirySchema.safeParse(await readBody(request));
  if (!parsed.success) return rejected(parsed.error);
  if (parsed.data.honeypot) return silentlyDropped();

  let reference: string;
  try {
    reference = await recordInquiry(parsed.data);
  } catch (err) {
    console.error('[inquiry] could not record', err);
    return failed();
  }

  // Nothing identifying in the subject or body — spec § 7. The console has the detail.
  await notifyOperator({
    kind: 'inquiry',
    urgency: parsed.data.urgency,
    subject: `New enquiry (${parsed.data.urgency.replace('_', ' ')})`,
    body: 'An enquiry has arrived. Open the console to see it.',
    payload: { inquiryId: reference, urgency: parsed.data.urgency },
  });

  return accepted(CONFIRMATION[parsed.data.urgency], reference);
}

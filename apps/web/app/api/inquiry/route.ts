/** Architecture spec § 6.1 — the household enquiry form. Writes to `inquiries` only. */
import type { NextRequest } from 'next/server';
import { inquirySchema, recordInquiry } from '@/lib/intake';
import { readForm, accepted, rejected, failed } from '@/lib/intakeResponse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  const parsed = inquirySchema.safeParse(await readForm(request));
  if (!parsed.success) return rejected(parsed.error);

  try {
    await recordInquiry(parsed.data);
  } catch (err) {
    console.error('[inquiry] could not record', err);
    return failed();
  }
  return accepted('Thank you. We will call you.');
}

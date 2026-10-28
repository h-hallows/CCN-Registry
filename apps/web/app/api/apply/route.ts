/**
 * Architecture spec § 6.1 — the provider application form. Writes to
 * `provider_applications` only. There is no public provider signup: applications are
 * reviewed, and the operator onboards.
 */
import type { NextRequest } from 'next/server';
import { applicationSchema, recordApplication } from '@/lib/intake';
import { readForm, accepted, rejected, failed } from '@/lib/intakeResponse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  const parsed = applicationSchema.safeParse(await readForm(request));
  if (!parsed.success) return rejected(parsed.error);

  try {
    await recordApplication(parsed.data);
  } catch (err) {
    console.error('[apply] could not record', err);
    return failed();
  }
  return accepted('Thank you. We read every application and will be in touch.');
}

/**
 * The provider application form. Writes to `provider_applications` only.
 *
 * There is no public provider signup: applications are reviewed and the operator
 * onboards. Nothing here creates a `providers` row.
 */
import type { NextRequest } from 'next/server';
import { ProviderApplicationSchema } from '@/lib/schemas/intake';
import { recordApplication } from '@/lib/intake';
import { rateLimit } from '@/lib/rateLimit';
import { notifyOperator } from '@/lib/notify';
import { accepted, failed, limited, readBody, rejected, silentlyDropped } from '@/lib/intakeResponse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  if (await rateLimit(request, { key: 'apply', max: 5, windowSec: 600 })) return limited();

  const parsed = ProviderApplicationSchema.safeParse(await readBody(request));
  if (!parsed.success) return rejected(parsed.error);
  if (parsed.data.honeypot) return silentlyDropped();

  let reference: string;
  try {
    reference = await recordApplication(parsed.data);
  } catch (err) {
    console.error('[apply] could not record', err);
    return failed();
  }

  await notifyOperator({
    kind: 'provider_application',
    subject: `New application (${parsed.data.type})`,
    body: 'An application has arrived. Open the console to see it.',
    payload: { applicationId: reference, type: parsed.data.type },
  });

  return accepted('Thank you. We read every application and will be in touch.', reference);
}

/**
 * Shared responses for the three public intake routes.
 *
 * Every response is deliberately uninformative about anything already in the database.
 * A public form that says "we already have a case for this household" is a disclosure,
 * and anyone can reach these.
 */
import type { ZodError } from 'zod';

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    return (await request.json()) as Record<string, unknown>;
  }
  const form = await request.formData();
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string') continue;
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** A short, quotable reference. Enough for the operator to find it, not an id to guess. */
export function accepted(message: string, id: string): Response {
  return Response.json(
    { ok: true, message, reference: id.slice(0, 8) },
    { status: 202 },
  );
}

/**
 * A filled honeypot gets the same 200 a real submission does. Telling a bot it was
 * detected teaches whoever wrote it to stop filling the field.
 */
export function silentlyDropped(): Response {
  return Response.json({ ok: true }, { status: 202 });
}

export function rejected(error: ZodError): Response {
  return Response.json(
    { ok: false, fieldErrors: error.flatten().fieldErrors },
    { status: 400 },
  );
}

export function limited(): Response {
  return Response.json(
    {
      ok: false,
      message: 'Too many submissions from here just now. Please call us instead.',
    },
    { status: 429 },
  );
}

export function failed(): Response {
  return Response.json(
    { ok: false, message: 'We could not record that just now. Please call us.' },
    { status: 503 },
  );
}

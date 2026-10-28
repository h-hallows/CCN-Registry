/**
 * Shared shapes for the three public intake routes.
 *
 * Every response is deliberately uninformative about anything already in the database.
 * A public form that says "we already have a case for this household" is a disclosure,
 * and these forms are reachable by anyone.
 */
import type { ZodError } from 'zod';

export async function readForm(request: Request): Promise<Record<string, unknown>> {
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

export function accepted(message: string): Response {
  return Response.json({ ok: true, message }, { status: 202 });
}

export function rejected(error: ZodError): Response {
  return Response.json(
    {
      ok: false,
      // Field messages only. Nothing about what is already on file.
      errors: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    },
    { status: 400 },
  );
}

export function failed(): Response {
  return Response.json(
    { ok: false, message: 'We could not record that just now. Please call us.' },
    { status: 503 },
  );
}

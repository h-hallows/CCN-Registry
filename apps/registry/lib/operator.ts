/**
 * The audit context for the current request. Every query-layer call takes one, so no
 * read or write is recorded without an actor.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getOperator } from '@/lib/auth';
import type { AuditContext } from '@/lib/audit';

export async function requireOperator(): Promise<{ operator: { email: string; displayName: string }; ctx: AuditContext }> {
  const operator = await getOperator();
  if (!operator) redirect('/login');
  const h = await headers();
  return {
    operator,
    ctx: {
      actor: operator.email,
      ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: h.get('user-agent'),
    },
  };
}

/**
 * M7: the disclosure log, exportable to CSV with disclosed-to, by, method, timestamp,
 * written due and sent. The export itself is an audited read — it takes identifiable
 * information out of the system.
 */
import { requireOperator } from '@/lib/operator';
import { audit } from '@/lib/audit';
import { disclosureLogToCsv, getCompliance } from '@/lib/queries/compliance';
import { civilLA, formatISODate } from '@ccn/core/domain';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { ctx } = await requireOperator();
  const { disclosureLog } = await getCompliance(ctx);
  const csv = disclosureLogToCsv(disclosureLog);
  const stamp = formatISODate(civilLA(new Date()));

  await audit({
    ...ctx, action: 'read', entity: 'disclosure_log_export',
    diff: { rows: disclosureLog.length },
  });

  return new Response(`﻿${csv}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="disclosure-log-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

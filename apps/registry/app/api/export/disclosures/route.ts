/**
 * M7: the disclosure log, exportable to CSV with disclosed-to, by, method, timestamp,
 * written due and sent. The export itself is an audited read — it takes identifiable
 * information out of the system.
 */
import { requireOperator } from '@/lib/operator';
import { audit } from '@/lib/audit';
import {
  countWrittenStatements, disclosureLogToCsv, getCompliance,
} from '@/lib/queries/compliance';
import { civilLA, formatISODate } from '@h-hallows/core/domain';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { ctx } = await requireOperator();
  /*
   * One instant, read twice. The § 1812.5095(f) state of every row is decided against
   * this clock and the filename is stamped from it, and two calls to `new Date()` can
   * straddle midnight in California — which would hand an auditor a file dated one day
   * whose overdue column was computed on another.
   */
  const now = new Date();
  const { disclosureLog } = await getCompliance(ctx, now);
  const csv = disclosureLogToCsv(disclosureLog);
  const stamp = formatISODate(civilLA(now));

  await audit({
    ...ctx, action: 'read', entity: 'disclosure_log_export',
    /*
     * The states as well as the row count. The audit entry is the record that this
     * file left the system, and one saying only how many rows it had cannot answer the
     * question it will be asked — whether the copy the auditor holds showed the
     * overdue statements that were overdue on the day it was taken.
     */
    diff: {
      rows: disclosureLog.length,
      writtenStatements: countWrittenStatements(disclosureLog),
    },
  });

  return new Response(`﻿${csv}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="disclosure-log-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

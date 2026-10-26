/** Compliance screen. Spec § 5 and § 7 (M7). */
import { getDb } from '@ccn/core/db';
import { auditRead, type AuditContext } from '@/lib/audit';
import { SEVERITY, requiredFor, type CredStatus } from '@ccn/core/domain';
import { listProvidersWithStanding, asDate, asTimestamp } from './providers';
import type { CredentialType } from '@ccn/core/schema';

export interface CredentialQueueRow {
  providerId: string;
  providerName: string;
  providerType: string;
  credentialId: string | null;
  type: CredentialType;
  label: string;
  expiresOn: string | null;
  status: CredStatus;
  verifiedOn: string | null;
}

export interface ReverifyRow {
  providerId: string;
  providerName: string;
  credentialId: string;
  label: string;
  verifiedOn: string;
  verificationSource: string;
}

export interface DisclosureLogRow {
  disclosureId: string;
  caseId: string;
  householdName: string;
  providerNames: string[];
  disclosedTo: string;
  disclosedBy: string;
  method: string;
  disclosedAt: string;
  writtenDueOn: string;
  writtenSentOn: string | null;
  writtenMethod: string | null;
  onTime: boolean | null;
}

export interface PaperworkGapRow {
  providerId: string;
  providerName: string;
  gaps: string[];
}

export interface RosterStanding {
  total: number;
  eligible: number;
  ineligible: number;
  inactive: number;
  doNotRefer: number;
  byType: { type: string; total: number; eligible: number }[];
}

export interface Compliance {
  credentialQueue: CredentialQueueRow[];
  reverifyQueue: ReverifyRow[];
  disclosureLog: DisclosureLogRow[];
  paperworkGaps: PaperworkGapRow[];
  rosterStanding: RosterStanding;
}

export async function getCompliance(ctx: AuditContext, today = new Date()): Promise<Compliance> {
  const { query } = await getDb();
  const standing = await listProvidersWithStanding(ctx, today);

  const credentialQueue: CredentialQueueRow[] = [];
  const reverifyQueue: ReverifyRow[] = [];
  const paperworkGaps: PaperworkGapRow[] = [];

  for (const s of standing) {
    const required = requiredFor(s.provider);

    for (const type of s.missing) {
      credentialQueue.push({
        providerId: s.provider.id,
        providerName: s.provider.fullName,
        providerType: s.provider.type,
        credentialId: null,
        type,
        label: `${type}`,
        expiresOn: null,
        status: 'expired',
        verifiedOn: null,
      });
    }

    for (const c of s.credentials) {
      if (required.includes(c.type) && c.status !== 'valid' && c.status !== 'none') {
        credentialQueue.push({
          providerId: s.provider.id,
          providerName: s.provider.fullName,
          providerType: s.provider.type,
          credentialId: c.id,
          type: c.type,
          label: c.label,
          expiresOn: c.expiresOn,
          status: c.status,
          verifiedOn: c.verifiedOn,
        });
      }
      if (c.needsReverify) {
        reverifyQueue.push({
          providerId: s.provider.id,
          providerName: s.provider.fullName,
          credentialId: c.id,
          label: c.label,
          verifiedOn: c.verifiedOn,
          verificationSource: c.verificationSource,
        });
      }
    }

    // § 1812.5095(b)(1), (d), (e): registry paperwork that must be on file.
    const gaps: string[] = [];
    if (!s.provider.agreementSignedOn) gaps.push('Referral agreement not signed — (b)(1)');
    if (!s.provider.writtenNoticeAckOn) gaps.push('Written notice not acknowledged — (d)');
    if (!s.provider.workAuthVerifiedOn) gaps.push('Work authorisation not verified — (e)');
    if (gaps.length) {
      paperworkGaps.push({
        providerId: s.provider.id, providerName: s.provider.fullName, gaps,
      });
    }
  }

  credentialQueue.sort(
    (a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.providerName.localeCompare(b.providerName),
  );
  reverifyQueue.sort((a, b) => a.verifiedOn.localeCompare(b.verifiedOn));

  const disclosureRows = await query(
    `SELECT d.id, d.case_id, d.disclosed_to, d.disclosed_by, d.method, d.disclosed_at,
            d.written_due_on, d.written_sent_on, d.written_method,
            h.display_name,
            coalesce(array_agg(p.full_name ORDER BY p.full_name)
                     FILTER (WHERE p.full_name IS NOT NULL), '{}') AS provider_names
       FROM disclosures d
       JOIN cases c ON c.id = d.case_id
       JOIN households h ON h.id = c.household_id
       LEFT JOIN referrals r ON r.disclosure_id = d.id
       LEFT JOIN providers p ON p.id = r.provider_id
      GROUP BY d.id, h.display_name
      ORDER BY d.disclosed_at DESC`,
  );

  const disclosureLog: DisclosureLogRow[] = disclosureRows.map((r) => {
    const dueOn = asDate(r.written_due_on) ?? '';
    const sentOn = asDate(r.written_sent_on);
    return {
      disclosureId: String(r.id),
      caseId: String(r.case_id),
      householdName: String(r.display_name),
      providerNames: (r.provider_names as string[]) ?? [],
      disclosedTo: String(r.disclosed_to),
      disclosedBy: String(r.disclosed_by),
      method: String(r.method),
      disclosedAt: asTimestamp(r.disclosed_at),
      writtenDueOn: dueOn,
      writtenSentOn: sentOn,
      writtenMethod: (r.written_method as string) ?? null,
      onTime: sentOn === null ? null : sentOn <= dueOn,
    };
  });

  const byTypeMap = new Map<string, { total: number; eligible: number }>();
  for (const s of standing) {
    const e = byTypeMap.get(s.provider.type) ?? { total: 0, eligible: 0 };
    e.total++;
    if (s.eligibility.eligible) e.eligible++;
    byTypeMap.set(s.provider.type, e);
  }

  await auditRead(ctx, 'compliance');

  return {
    credentialQueue,
    reverifyQueue,
    disclosureLog,
    paperworkGaps,
    rosterStanding: {
      total: standing.length,
      eligible: standing.filter((s) => s.eligibility.eligible).length,
      ineligible: standing.filter((s) => !s.eligibility.eligible).length,
      inactive: standing.filter((s) => s.provider.status === 'inactive').length,
      doNotRefer: standing.filter((s) => s.provider.status === 'do_not_refer').length,
      byType: [...byTypeMap.entries()]
        .map(([type, v]) => ({ type, ...v }))
        .sort((a, b) => a.type.localeCompare(b.type)),
    },
  };
}

/** M7: the disclosure log exports with disclosed-to, by, method, timestamp, written due and sent. */
export function disclosureLogToCsv(rows: DisclosureLogRow[]): string {
  const header = [
    'disclosure_id', 'case_id', 'household', 'providers_referred', 'disclosed_to',
    'disclosed_by', 'method', 'disclosed_at', 'written_due_on', 'written_sent_on',
    'written_method', 'on_time',
  ];
  const body = rows.map((r) => [
    r.disclosureId, r.caseId, r.householdName, r.providerNames.join('; '), r.disclosedTo,
    r.disclosedBy, r.method, r.disclosedAt, r.writtenDueOn, r.writtenSentOn ?? '',
    r.writtenMethod ?? '', r.onTime === null ? 'not sent' : String(r.onTime),
  ]);
  return [header, ...body].map((cells) => cells.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value: string): string {
  // A leading =, +, - or @ is a spreadsheet formula injection vector; prefix it.
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

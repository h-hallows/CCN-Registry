/** Compliance screen. Spec § 5 and § 7 (M7). */
import { getDb } from '@h-hallows/core/db';
import { auditRead, type AuditContext } from '@/lib/audit';
import {
  SEVERITY, civilLA, formatISODate, requiredFor, type CredStatus,
} from '@h-hallows/core/domain';
import { dueWording } from '@/lib/domain/buckets';
import { listProvidersWithStanding, asDate, asTimestamp } from './providers';
import type { CredentialType } from '@h-hallows/core/schema';

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

/**
 * The § 1812.5095(f) state of one written statement, named once.
 *
 * What stood here was `onTime: boolean | null`, in which `null` meant two opposite
 * things: a statement that is overdue and was never sent, which is the breach the
 * section exists to catch, and one that is not yet due, which is lawful. Every consumer
 * then re-derived the difference from that null and a date, and one of them could not —
 * the screen told them apart by calling `dueWording` on the due date while
 * `disclosureLogToCsv` wrote "not sent" for both, so the export and the screen disagreed
 * about the same row and the auditable artifact was the one that could not show a
 * breach.
 *
 * Four states, because the section measures two things and each has two answers:
 * whether the statement went out at all, and whether it went out by the deadline.
 */
export type WrittenStatementState =
  | 'sent_on_time'
  | 'sent_late'
  | 'overdue'
  | 'not_yet_due';

/**
 * Which state a disclosure row is in. The only place this decision is made.
 *
 * `dueOn` is the stored `written_due_on`, counted once by `writtenStatementDueOn` when
 * the disclosure was recorded, so this compares against it and never recomputes it: a
 * deadline recomputed later moves whenever the California holiday table or the counting
 * rule changes, and the date the operator was given is the date they are held to.
 *
 * `today` is California's civil date rather than the server's. A UTC host is a day ahead
 * of Pacific from 5pm, which is long enough to call a statement that is still due
 * tomorrow a breach tonight.
 *
 * Due today is not yet a breach — the statement may still go out before the day ends,
 * and that is the line `dueWording` already drew on the screen.
 */
export function writtenStatementState(
  dueOn: string,
  sentOn: string | null,
  today: Date,
): WrittenStatementState {
  if (sentOn !== null) return sentOn <= dueOn ? 'sent_on_time' : 'sent_late';
  return dueOn < formatISODate(civilLA(today)) ? 'overdue' : 'not_yet_due';
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
  writtenState: WrittenStatementState;
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
      writtenState: writtenStatementState(dueOn, sentOn, today),
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

export interface WrittenStatementCell {
  /** The day the statement went out, where the cell has one to name. */
  sentOn: string | null;
  /** What the cell says about the state. */
  wording: string;
  /** The custom property the screen paints the cell with. */
  color: string;
}

/**
 * The disclosure log's "Written sent" cell — the screen's one rendering of the state.
 *
 * Wording and colour are decided here, beside the exported cell, because they are the
 * same claim in another form. It was the colour, chosen on the screen from a null rather
 * than from a state, that painted a statement which was not yet due in the same critical
 * red as a missed statutory deadline.
 *
 * `today` is the clock the rows were built with. It supplies only the day count in the
 * wording; the classification comes from `state` and is never decided again here.
 */
export function writtenStatementCell(
  row: DisclosureLogRow,
  today: Date,
): WrittenStatementCell {
  switch (row.writtenState) {
    case 'sent_on_time':
      return {
        sentOn: row.writtenSentOn, wording: 'sent on time', color: 'var(--color-ok)',
      };
    case 'sent_late':
      return {
        sentOn: row.writtenSentOn, wording: 'sent late', color: 'var(--color-expired)',
      };
    case 'overdue':
      // Critical belongs to this state alone. It is the § 1812.5095(f) breach, and a
      // colour that also means "nothing is wrong yet" is not a warning.
      return {
        sentOn: null, wording: dueWording(row.writtenDueOn, today),
        color: 'var(--color-critical)',
      };
    case 'not_yet_due':
      return {
        sentOn: null, wording: dueWording(row.writtenDueOn, today),
        color: 'var(--ink-soft)',
      };
  }
}

/**
 * How many rows stand in each state.
 *
 * A record over the whole union rather than a `filter` per figure on the screen: the
 * counter that read "outstanding" put the overdue and the not-yet-due in one bucket, so
 * the number at the top of the compliance screen could not be read as a number of
 * breaches. Keyed by the union, a state added later cannot go uncounted without the
 * typecheck saying so.
 */
export function countWrittenStatements(
  rows: DisclosureLogRow[],
): Record<WrittenStatementState, number> {
  const counts: Record<WrittenStatementState, number> = {
    sent_on_time: 0, sent_late: 0, overdue: 0, not_yet_due: 0,
  };
  for (const r of rows) counts[r.writtenState] += 1;
  return counts;
}

/**
 * M7: the disclosure log exports with disclosed-to, by, method, timestamp, written due
 * and sent.
 *
 * The last column was `on_time`, carrying 'true', 'false' or 'not sent' — and 'not sent'
 * stood for an overdue statement and for one that was not yet due alike, so the single
 * row an auditor opens this file to find read exactly like a lawful one. The column is
 * now the state itself: `overdue` names the breach in a value a filter can select, and
 * one that cannot be mistaken for `not_yet_due`.
 */
export function disclosureLogToCsv(rows: DisclosureLogRow[]): string {
  const header = [
    'disclosure_id', 'case_id', 'household', 'providers_referred', 'disclosed_to',
    'disclosed_by', 'method', 'disclosed_at', 'written_due_on', 'written_sent_on',
    'written_method', 'written_state',
  ];
  const body = rows.map((r) => [
    r.disclosureId, r.caseId, r.householdName, r.providerNames.join('; '), r.disclosedTo,
    r.disclosedBy, r.method, r.disclosedAt, r.writtenDueOn, r.writtenSentOn ?? '',
    r.writtenMethod ?? '', r.writtenState,
  ]);
  return [header, ...body].map((cells) => cells.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value: string): string {
  // A leading =, +, - or @ is a spreadsheet formula injection vector; prefix it.
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

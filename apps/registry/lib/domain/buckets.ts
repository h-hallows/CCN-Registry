/**
 * Today-screen derivations. Spec § 5.
 *
 * "If a row does not require action, it does not belong on this screen." Everything here
 * is a pure function over already-fetched rows, so the ordering is testable without a
 * database.
 *
 * SEVEN buckets ship, not eight. The § 5 "coverage gaps in the next 7 days" bucket is
 * omitted because the scheduling and coverage surface is blocked by the § 0.5 item 2
 * nine-factor audit — "coordinate schedules" is the exact activity § 1812.5095(b)(5) and
 * § 687.2(e) constrain, and a database turns it into a timestamped written record. The
 * `coverage_gaps` table exists so the schema accepts the feature; nothing reads it.
 * See /DEFERRED.md. It slots in between `credentialAlerts` and `thinBench` below.
 */
import type { CareType, UrgencyValue } from '@ccn/core/schema';

/** Shared with every other surface; see @ccn/core/domain/care. */
import { URGENCY_ORDER, URGENCY_LABEL } from '@ccn/core/domain';
export { URGENCY_ORDER, URGENCY_LABEL };
import { SEVERITY, civilLA, daysBetween, parseISODate } from '@ccn/core/domain';
import type { CredStatus } from '@ccn/core/domain';

export interface BlockingRow {
  caseId: string;
  householdName: string;
  providerId: string;
  providerName: string;
  reason: string;
}

export interface NeedsResponseRow {
  caseId: string;
  householdName: string;
  urgency: UrgencyValue;
  createdAt: string;
  care: CareType;
}

export interface NoPhysicianRow {
  caseId: string;
  householdName: string;
  care: CareType;
  status: string;
}

export interface CredentialAlertRow {
  providerId: string;
  providerName: string;
  credentialLabel: string;
  expiresOn: string | null;
  status: CredStatus;
}

export interface ThinBenchRow {
  caseId: string;
  householdName: string;
  eligibleAlternates: number;
}

export interface WrittenDueRow {
  disclosureId: string;
  caseId: string;
  householdName: string;
  disclosedTo: string;
  writtenDueOn: string;
}

export interface EndingSoonRow {
  caseId: string;
  householdName: string;
  endsOn: string;
}

export interface TodayInput {
  blocking: BlockingRow[];
  needsResponse: NeedsResponseRow[];
  noPhysician: NoPhysicianRow[];
  credentialAlerts: CredentialAlertRow[];
  thinBench: ThinBenchRow[];
  writtenDue: WrittenDueRow[];
  endingSoon: EndingSoonRow[];
}

export interface TodayBucket<T> {
  key: string;
  title: string;
  /** Why this bucket exists, shown as the subtitle. */
  blurb: string;
  rows: T[];
}

export interface Today {
  blocking: TodayBucket<BlockingRow>;
  needsResponse: TodayBucket<NeedsResponseRow>;
  noPhysician: TodayBucket<NoPhysicianRow>;
  credentialAlerts: TodayBucket<CredentialAlertRow>;
  thinBench: TodayBucket<ThinBenchRow>;
  writtenDue: TodayBucket<WrittenDueRow>;
  endingSoon: TodayBucket<EndingSoonRow>;
  /** Buckets in § 5 order, with the empty ones still present so counts can render. */
  ordered: TodayBucket<unknown>[];
  totalActions: number;
}

/** § 5 ranked work queue, in this order. */
export function buildToday(input: TodayInput, today: Date): Today {
  const t = civilLA(today);

  const blocking: TodayBucket<BlockingRow> = {
    key: 'blocking',
    title: 'Blocking',
    blurb: 'An active case whose referred provider is no longer eligible. A lapsed credential is reaching a household.',
    rows: [...input.blocking].sort((a, b) => a.householdName.localeCompare(b.householdName)),
  };

  const needsResponse: TodayBucket<NeedsResponseRow> = {
    key: 'needs-response',
    title: 'Needs response',
    blurb: 'An open enquiry with no logged call. Discharge first, then by age.',
    rows: [...input.needsResponse].sort(
      (a, b) =>
        URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]
        || Date.parse(a.createdAt) - Date.parse(b.createdAt),
    ),
  };

  const noPhysician: TodayBucket<NoPhysicianRow> = {
    key: 'no-physician',
    title: 'Skilled case, no physician of record',
    blurb: 'Cannot be referred until an ordering physician is on the household record (§ 1812.524).',
    rows: [...input.noPhysician].sort((a, b) => a.householdName.localeCompare(b.householdName)),
  };

  const credentialAlerts: TodayBucket<CredentialAlertRow> = {
    key: 'credentials',
    title: 'Credential alerts',
    blurb: 'Expired first, then critical, then soon, then upcoming.',
    rows: [...input.credentialAlerts].sort(
      (a, b) =>
        SEVERITY[a.status] - SEVERITY[b.status]
        || compareNullableDate(a.expiresOn, b.expiresOn)
        || a.providerName.localeCompare(b.providerName),
    ),
  };

  // --- coverage gaps in the next 7 days would slot in here (blocked; see /DEFERRED.md) ---

  const thinBench: TodayBucket<ThinBenchRow> = {
    key: 'thin-bench',
    title: 'Thin bench',
    blurb: 'Fewer than two eligible alternates. One illness away from a service failure.',
    rows: [...input.thinBench].sort((a, b) => a.eligibleAlternates - b.eligibleAlternates),
  };

  const writtenDue: TodayBucket<WrittenDueRow> = {
    key: 'written-due',
    title: 'Written disclosures due',
    blurb: 'The § 1812.5095(f) written statement, due three California business days after the spoken disclosure.',
    rows: [...input.writtenDue].sort((a, b) => a.writtenDueOn.localeCompare(b.writtenDueOn)),
  };

  const endingSoon: TodayBucket<EndingSoonRow> = {
    key: 'ending-soon',
    title: 'Engagements ending within 14 days',
    blurb: 'Confirm whether care continues, and record the reason if it does not.',
    rows: input.endingSoon
      .filter((r) => {
        const d = daysBetween(t, parseISODate(r.endsOn));
        return d >= 0 && d <= 14;
      })
      .sort((a, b) => a.endsOn.localeCompare(b.endsOn)),
  };

  const ordered = [
    blocking, needsResponse, noPhysician, credentialAlerts, thinBench, writtenDue, endingSoon,
  ] as TodayBucket<unknown>[];

  return {
    blocking, needsResponse, noPhysician, credentialAlerts, thinBench, writtenDue, endingSoon,
    ordered,
    totalActions: ordered.reduce((n, b) => n + b.rows.length, 0),
  };
}

export const THIN_BENCH_TARGET = 2;
export const ENDING_SOON_DAYS = 14;

function compareNullableDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

/** Relative wording for the queue: "3 days overdue", "due today", "in 5 days". */
export function dueWording(dueOn: string, today: Date): string {
  const d = daysBetween(civilLA(today), parseISODate(dueOn));
  if (d < 0) return `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} overdue`;
  if (d === 0) return 'due today';
  if (d === 1) return 'due tomorrow';
  return `due in ${d} days`;
}

export function ageWording(createdAt: string, now: Date): string {
  const hours = Math.floor((now.getTime() - Date.parse(createdAt)) / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

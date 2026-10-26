/** § 5 Today screen ordering, and the seven-bucket shape. */
import { describe, expect, it } from 'vitest';
import { buildToday, dueWording, type TodayInput } from '@/lib/domain/buckets';

const TODAY = new Date('2026-10-24T17:00:00.000Z');

const empty: TodayInput = {
  blocking: [], needsResponse: [], noPhysician: [], credentialAlerts: [],
  thinBench: [], writtenDue: [], endingSoon: [],
};

describe('bucket order and shape', () => {
  it('ships seven buckets, in § 5 order, with coverage gaps absent', () => {
    const today = buildToday(empty, TODAY);
    expect(today.ordered.map((b) => b.key)).toEqual([
      'blocking', 'needs-response', 'no-physician', 'credentials',
      'thin-bench', 'written-due', 'ending-soon',
    ]);
    expect(today.ordered.map((b) => b.key)).not.toContain('coverage-gaps');
  });

  it('counts nothing to do when nothing needs doing', () => {
    expect(buildToday(empty, TODAY).totalActions).toBe(0);
  });
});

describe('needs response ordering', () => {
  it('puts discharge first, then by age within a tier', () => {
    const today = buildToday({
      ...empty,
      needsResponse: [
        { caseId: 'c1', householdName: 'Routine, old', urgency: 'routine', care: 'companion', createdAt: '2026-10-01T10:00:00Z' },
        { caseId: 'c2', householdName: 'Discharge, new', urgency: 'discharge', care: 'post_surgical', createdAt: '2026-10-24T09:00:00Z' },
        { caseId: 'c3', householdName: 'Same day', urgency: 'same_day', care: 'respite', createdAt: '2026-10-23T09:00:00Z' },
        { caseId: 'c4', householdName: 'Discharge, older', urgency: 'discharge', care: 'companion', createdAt: '2026-10-23T09:00:00Z' },
      ],
    }, TODAY);
    expect(today.needsResponse.rows.map((r) => r.caseId)).toEqual(['c4', 'c2', 'c3', 'c1']);
  });
});

describe('credential alerts ordering', () => {
  it('orders expired, critical, soon, upcoming', () => {
    const today = buildToday({
      ...empty,
      credentialAlerts: [
        { providerId: 'p1', providerName: 'A', credentialLabel: 'CPR/BLS', expiresOn: '2026-12-01', status: 'soon' },
        { providerId: 'p2', providerName: 'B', credentialLabel: 'TB clearance', expiresOn: '2026-10-23', status: 'expired' },
        { providerId: 'p3', providerName: 'C', credentialLabel: 'RN license', expiresOn: '2027-01-15', status: 'upcoming' },
        { providerId: 'p4', providerName: 'D', credentialLabel: 'Live Scan', expiresOn: '2026-10-28', status: 'critical' },
      ],
    }, TODAY);
    expect(today.credentialAlerts.rows.map((r) => r.status))
      .toEqual(['expired', 'critical', 'soon', 'upcoming']);
  });
});

describe('ending soon window', () => {
  it('keeps only engagements ending in the next fourteen days', () => {
    const today = buildToday({
      ...empty,
      endingSoon: [
        { caseId: 'in', householdName: 'In window', endsOn: '2026-11-02' },
        { caseId: 'edge', householdName: 'Exactly fourteen', endsOn: '2026-11-07' },
        { caseId: 'out', householdName: 'Too far', endsOn: '2026-11-08' },
        { caseId: 'past', householdName: 'Already past', endsOn: '2026-10-20' },
        { caseId: 'today', householdName: 'Ends today', endsOn: '2026-10-24' },
      ],
    }, TODAY);
    expect(today.endingSoon.rows.map((r) => r.caseId)).toEqual(['today', 'in', 'edge']);
  });
});

describe('thin bench', () => {
  it('puts the emptiest bench first', () => {
    const today = buildToday({
      ...empty,
      thinBench: [
        { caseId: 'a', householdName: 'One alternate', eligibleAlternates: 1 },
        { caseId: 'b', householdName: 'No alternates', eligibleAlternates: 0 },
      ],
    }, TODAY);
    expect(today.thinBench.rows.map((r) => r.caseId)).toEqual(['b', 'a']);
  });
});

describe('due wording', () => {
  it('reads as a deadline, not a date', () => {
    expect(dueWording('2026-10-24', TODAY)).toBe('due today');
    expect(dueWording('2026-10-25', TODAY)).toBe('due tomorrow');
    expect(dueWording('2026-10-29', TODAY)).toBe('due in 5 days');
    expect(dueWording('2026-10-21', TODAY)).toBe('3 days overdue');
    expect(dueWording('2026-10-23', TODAY)).toBe('1 day overdue');
  });
});

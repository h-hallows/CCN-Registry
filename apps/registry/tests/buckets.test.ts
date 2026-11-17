/** § 5 Today screen ordering, and the seven-bucket shape. */
import { describe, expect, it } from 'vitest';
import { buildToday, dueWording, type TodayInput } from '@/lib/domain/buckets';
import type { CareType } from '@h-hallows/core/schema';

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

describe('the ending-soon window is measured in California', () => {
  /*
   * The only date decision in this module, and the one class of bug this project has
   * shipped three times: a window measured from the server's date instead of the
   * operator's. V1-REVIEW § 2 records two, `capacity()` was the third this month.
   *
   * The instant below is 17:30 on New Year's Eve in Los Angeles, which is 01:30 on New
   * Year's Day in UTC. Decided in UTC, "today" is the 1st, every engagement ending on
   * the 31st is a day in the past, and they all drop off the screen — at half past five
   * in the evening, on the day they end, which is the last moment anybody could do
   * something about them.
   *
   * The existing fixed date in this file is 10:00 Pacific, when the two agree. That is
   * the time of day a test gets written and the time of day a bug like this hides.
   */
  const NEW_YEARS_EVE_EVENING = new Date('2027-01-01T01:30:00.000Z');

  const ending = (endsOn: string) => ({
    caseId: `case-${endsOn}`,
    householdName: `Household ${endsOn}`,
    care: 'personal_care' as CareType,
    endsOn,
    primaryProviderName: 'Alma Reyes',
  });

  function window(endsOn: string[]): string[] {
    return buildToday(
      { ...empty, endingSoon: endsOn.map(ending) },
      NEW_YEARS_EVE_EVENING,
    ).endingSoon.rows.map((r) => r.endsOn);
  }

  it('keeps an engagement ending tonight, California time', () => {
    expect(window(['2026-12-31'])).toEqual(['2026-12-31']);
  });

  it('keeps the fourteenth day and drops the fifteenth', () => {
    expect(window(['2027-01-14', '2027-01-15'])).toEqual(['2027-01-14']);
  });

  it('drops one that ended yesterday', () => {
    expect(window(['2026-12-30'])).toEqual([]);
  });

  it('counts the window across a year boundary without losing a day', () => {
    const all = [
      '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-07',
      '2027-01-14', '2027-01-15',
    ];
    // Fifteen days inclusive, from today to today + 14, and nothing outside them.
    expect(window(all)).toEqual(['2026-12-31', '2027-01-01', '2027-01-07', '2027-01-14']);
  });

  it('counts the window across a leap day too', () => {
    const leapEvening = new Date('2028-02-29T01:30:00.000Z'); // 17:30 on the 28th, LA
    const rows = buildToday(
      {
        ...empty,
        endingSoon: ['2028-02-28', '2028-02-29', '2028-03-13', '2028-03-14']
          .map(ending),
      },
      leapEvening,
    ).endingSoon.rows.map((r) => r.endsOn);
    // 28 Feb + 14 = 13 Mar in a leap year, and 14 Mar is outside it.
    expect(rows).toEqual(['2028-02-28', '2028-02-29', '2028-03-13']);
  });
});

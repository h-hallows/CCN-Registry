/**
 * § 1812.5095(d). DRAFTED TO THE STATUTORY REQUIREMENT — counsel must approve.
 *
 * Given to the provider on or before signing the referral agreement, acknowledged into
 * `providers.written_notice_ack_on`.
 *
 * For nurses this must be accompanied by the § 1812.527 fee schedule — and that schedule
 * must already have been provided BEFORE the interview, not at signing. Two different
 * timings for two documents handed over in the same meeting.
 */
import type { StatutoryText } from './types';

export const PROVIDER_NOTICE: StatutoryText = {
  VERSION: '0',
  LAST_REVIEWED: '2026-10-31',
  status: 'draft',
  citation: 'Cal. Civ. Code § 1812.5095(d)',
  purpose:
    'Given to a referred provider on or before signing the referral agreement. '
    + 'Acknowledged into providers.written_notice_ack_on.',
  text:
    'You may be obliged to obtain business permits or licences where state or local law '
    + 'requires them.\n\n'
    + 'You are not eligible for unemployment insurance, state disability insurance, '
    + 'Social Security or workers’ compensation benefits through Century City '
    + 'Concierge Nursing.\n\n'
    + 'Where you are self-employed, you are required to pay self-employment tax, state '
    + 'tax and federal income taxes.',
};

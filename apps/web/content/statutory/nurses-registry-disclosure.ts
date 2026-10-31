/**
 * § 1812.533(b)(4). DRAFTED TO THE STATUTORY REQUIREMENT — counsel must approve.
 *
 * The statute specifies required content and the phrase "a nurses' registry only", but
 * does not supply full wording. This is a draft and `status` says so, which is what
 * stops it being delivered.
 *
 * THE TIMING IS THE THING TO GET RIGHT. The § 1812.5095(f) written statement is due
 * within three business days AFTER a referral. This one must be in the patient's hands
 * BEFORE any nursing care starts. A single "send within three days" job would satisfy
 * one and breach the other, which is why migration 0004 makes it a status gate on the
 * case rather than a reminder.
 */
import type { StatutoryText } from './types';

export const NURSES_REGISTRY_DISCLOSURE: StatutoryText = {
  VERSION: '0',
  LAST_REVIEWED: '2026-10-31',
  status: 'draft',
  citation: "Cal. Civ. Code § 1812.533(b)(4)",
  purpose:
    'Delivered to the person receiving nursing services at their residence, with the '
    + 'complaint contacts, before they are under the care of any nursing personnel. '
    + 'Required for RN and LVN referrals.',
  text:
    'Century City Concierge Nursing does not perform home health agency services. '
    + "It is a nurses' registry only.\n\n"
    + 'Nursing services are provided by a self-employed private duty nurse under the '
    + 'direction of a physician. Century City Concierge Nursing does not employ, direct, '
    + 'control or supervise the nurse in the performance of nursing services.\n\n'
    + 'Complaints concerning licensed nursing personnel may be directed to your local '
    + 'district attorney and to the California Department of Consumer Affairs. Contact '
    + 'details for both are provided with this notice.',
};

/**
 * § 1812.533(b)(4) complaint contacts.
 *
 * The addresses and phone numbers of the local district attorney and the California
 * Department of Consumer Affairs must reach the patient BEFORE they are under the care
 * of any nursing personnel — not with the first invoice, not at the first shift unless
 * counsel says that counts.
 *
 * These are public facts rather than drafted wording, but they are still unfilled: a
 * guessed address on a statutory complaint notice is worse than a blank one, because it
 * sends a complaint nowhere while looking like it works.
 */
import type { StatutoryText } from './types';

export interface ComplaintContact {
  readonly body: string;
  readonly address: string;
  readonly telephone: string;
}

export const COMPLAINT_CONTACTS: readonly ComplaintContact[] = [
  { body: 'Office of the District Attorney, County of Los Angeles', address: '', telephone: '' },
  { body: 'California Department of Consumer Affairs', address: '', telephone: '' },
];

export const COMPLAINT_CONTACTS_DOCUMENT: StatutoryText = {
  VERSION: '0',
  LAST_REVIEWED: '2026-10-31',
  status: 'unfilled',
  citation: "Cal. Civ. Code § 1812.533(b)(4)",
  purpose:
    'Accompanies the residence disclosure. Must reach the patient before they are under '
    + 'the care of any nursing personnel.',
  text: '',
};

export function contactsComplete(): boolean {
  return COMPLAINT_CONTACTS.every((c) => c.address.trim() !== '' && c.telephone.trim() !== '');
}

/**
 * The statutory texts. One file per document, imported and never retyped.
 * See README.md in this directory for which statute each answers and who may change it.
 */
export type { StatutoryText } from './types';
export { isDeliverable } from './types';

export { ORAL_DISCLOSURE } from './oral-disclosure';
export { WRITTEN_STATEMENT, MIN_POINT_SIZE as WRITTEN_STATEMENT_MIN_POINT } from './written-statement';
export { NURSES_REGISTRY_DISCLOSURE } from './nurses-registry-disclosure';
export { PROVIDER_NOTICE } from './provider-notice';
export {
  REFERRAL_AGENCY_LINE, BUSINESS_CONTACT, MIN_POINT_SIZE as FOOTER_MIN_POINT,
} from './referral-agency-line';
export { COMPLAINT_CONTACTS, COMPLAINT_CONTACTS_DOCUMENT, contactsComplete } from './complaint-contacts';

import { ORAL_DISCLOSURE } from './oral-disclosure';
import { WRITTEN_STATEMENT } from './written-statement';
import { NURSES_REGISTRY_DISCLOSURE } from './nurses-registry-disclosure';
import { PROVIDER_NOTICE } from './provider-notice';
import { REFERRAL_AGENCY_LINE, BUSINESS_CONTACT } from './referral-agency-line';
import { COMPLAINT_CONTACTS_DOCUMENT } from './complaint-contacts';

export const ALL_STATUTORY_TEXTS = [
  ORAL_DISCLOSURE, WRITTEN_STATEMENT, NURSES_REGISTRY_DISCLOSURE, PROVIDER_NOTICE,
  REFERRAL_AGENCY_LINE, BUSINESS_CONTACT, COMPLAINT_CONTACTS_DOCUMENT,
] as const;

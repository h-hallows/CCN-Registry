/**
 * The three public write paths. Spec § 3.
 *
 * They land in `inquiries` and `provider_applications` and nowhere else. No public path
 * creates a `households`, `cases` or `providers` row — the operator converts from the
 * console. That keeps the entire live record set behind one human, which is both the
 * compliance posture and the product.
 *
 * Nothing here may touch `referrals`, `timeline_entries` or `disclosures`. A test
 * asserts it statically, and in deployment the web project's database role does not
 * hold the privilege either (architecture spec § 4).
 */
import { getDb } from '@ccn/core/db';
import type {
  InquiryInput, PartnerReferralInput, ProviderApplicationInput,
} from './schemas/intake';

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

/** Enum values are stored as the household chose them; "not_sure" is a real answer. */
const nullIfUnsure = (v: string) => (v === 'not_sure' ? null : v);

export async function recordInquiry(input: InquiryInput): Promise<string> {
  const { query } = await getDb();
  const [row] = await query<{ id: string }>(
    `INSERT INTO inquiries
       (name, phone, email, relationship, care_type, area, pattern_note, start_note,
        urgency, payment_method, message, source_path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      input.name.trim(), input.phone.trim(), blank(input.email), input.relationship,
      nullIfUnsure(input.careType), input.area, blank(input.patternNote),
      blank(input.startNote), input.urgency, nullIfUnsure(input.paymentMethod),
      blank(input.message), input.sourcePath,
    ],
  );
  if (!row) throw new Error('inquiry was not recorded');
  return row.id;
}

export async function recordApplication(input: ProviderApplicationInput): Promise<string> {
  const { query } = await getDb();
  const [row] = await query<{ id: string }>(
    `INSERT INTO provider_applications
       (full_name, phone, email, type, license_number, areas, languages, specialties,
        experience_note, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      input.fullName.trim(), input.phone.trim(), input.email.trim(), input.type,
      blank(input.licenseNumber), input.areas, input.languages, input.specialties,
      blank(input.experienceNote), blank(input.message),
    ],
  );
  if (!row) throw new Error('application was not recorded');
  return row.id;
}

/**
 * A partner referral is an inquiry with the partner block attached.
 *
 * The person we will call is the family contact, not the partner — so `name` and
 * `phone` are theirs. The partner's own details go in `referrer`, along with the
 * patient's INITIALS and the consent confirmation. A full patient name is never taken.
 */
export async function recordPartnerReferral(input: PartnerReferralInput): Promise<string> {
  const { query } = await getDb();
  const referrer = {
    partnerName: input.partnerName,
    partnerOrg: input.partnerOrg,
    partnerRole: input.partnerRole,
    partnerPhone: input.partnerPhone,
    partnerEmail: input.partnerEmail,
    patientInitials: input.patientInitials,
    consentConfirmed: input.consentNote,
    confirmedAt: new Date().toISOString(),
  };

  const [row] = await query<{ id: string }>(
    `INSERT INTO inquiries
       (name, phone, relationship, care_type, area, urgency, message, source_path, referrer)
     VALUES ($1,$2,'professional',$3,$4,$5,$6,'/refer',$7::jsonb)
     RETURNING id`,
    [
      input.contactName.trim(), input.contactPhone.trim(),
      nullIfUnsure(input.careType), input.area, input.urgency,
      blank(input.note), JSON.stringify(referrer),
    ],
  );
  if (!row) throw new Error('referral was not recorded');
  return row.id;
}

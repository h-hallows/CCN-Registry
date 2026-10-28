/**
 * Public intake. Architecture spec § 3.3 and § 6.1.
 *
 * These are the only writes the public surface performs, and they land in `inquiries`
 * and `provider_applications` — never in `households`, `cases` or `providers`. The
 * operator converts from the console. That keeps the entire live record set behind one
 * human, which is both the compliance posture and the product.
 *
 * Nothing here may touch `referrals`, `timeline_entries` or `disclosures`. A test
 * asserts it, and in deployment the web project's database role will not hold the
 * privilege either (§ 4, "service-role keys").
 */
import { z } from 'zod';
import { getDb } from '@ccn/core/db';

const CARE_TYPES = [
  'companion', 'personal_care', 'skilled_nursing', 'post_surgical',
  'overnight_newborn', 'respite', 'hospice_support',
] as const;
const URGENCIES = ['discharge', 'same_day', 'next_day', 'routine'] as const;
const PAYMENT_METHODS = ['private', 'ltc_policy', 'va', 'other'] as const;
const PROVIDER_TYPES = ['RN', 'LVN', 'CNA', 'HCA', 'companion'] as const;

const optionalText = z.string().trim().max(2000).optional().or(z.literal(''));

export const inquirySchema = z.object({
  name: z.string().trim().min(2, 'Please give us a name.').max(200),
  phone: optionalText,
  email: z.string().trim().email('That email does not look right.').optional().or(z.literal('')),
  relationship: optionalText,
  careType: z.enum(CARE_TYPES).optional(),
  area: optionalText,
  patternNote: optionalText,
  startNote: optionalText,
  urgency: z.enum(URGENCIES).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  message: optionalText,
  sourcePath: optionalText,
  /** Set by the partner route only. A household form cannot claim a partner. */
  partnerId: z.string().uuid().optional(),
}).refine((v) => Boolean(v.phone?.trim() || v.email?.trim()), {
  message: 'Please leave a phone number or an email address so we can reach you.',
  path: ['phone'],
});

export type InquiryInput = z.infer<typeof inquirySchema>;

export const applicationSchema = z.object({
  fullName: z.string().trim().min(2, 'Please give us your name.').max(200),
  phone: optionalText,
  email: z.string().trim().email('That email does not look right.').optional().or(z.literal('')),
  type: z.enum(PROVIDER_TYPES).optional(),
  licenseNumber: optionalText,
  areas: z.array(z.string().trim().max(100)).max(20).optional(),
  languages: z.array(z.string().trim().max(60)).max(20).optional(),
  specialties: z.array(z.string().trim().max(60)).max(30).optional(),
  experienceNote: optionalText,
  message: optionalText,
}).refine((v) => Boolean(v.phone?.trim() || v.email?.trim()), {
  message: 'Please leave a phone number or an email address so we can reach you.',
  path: ['phone'],
});

export type ApplicationInput = z.infer<typeof applicationSchema>;

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

/**
 * Record an enquiry. Returns nothing identifying — the response must not confirm or
 * deny anything about an existing household.
 */
export async function recordInquiry(
  input: InquiryInput,
  meta: { utm?: Record<string, string> } = {},
): Promise<void> {
  const { query } = await getDb();
  await query(
    `INSERT INTO inquiries
       (name, phone, email, relationship, care_type, area, pattern_note, start_note,
        urgency, payment_method, message, source_path, utm, partner_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
    [
      input.name.trim(), blank(input.phone), blank(input.email), blank(input.relationship),
      input.careType ?? null, blank(input.area), blank(input.patternNote),
      blank(input.startNote), input.urgency ?? null, input.paymentMethod ?? null,
      blank(input.message), blank(input.sourcePath),
      JSON.stringify(meta.utm ?? {}), input.partnerId ?? null,
    ],
  );
}

export async function recordApplication(input: ApplicationInput): Promise<void> {
  const { query } = await getDb();
  await query(
    `INSERT INTO provider_applications
       (full_name, phone, email, type, license_number, areas, languages, specialties,
        experience_note, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.fullName.trim(), blank(input.phone), blank(input.email), input.type ?? null,
      blank(input.licenseNumber), input.areas ?? [], input.languages ?? [],
      input.specialties ?? [], blank(input.experienceNote), blank(input.message),
    ],
  );
}

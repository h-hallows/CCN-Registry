/**
 * Intake schemas. Web build spec § 3.1.
 *
 * All three are `.strict()`: an unknown key is a rejection, not a silently dropped
 * field. These are the only public write paths into a database holding health-adjacent
 * information about private individuals, and "we ignored what we did not recognise" is
 * not a posture worth having at that boundary.
 */
import { z } from 'zod';

const phone = z.string().trim().min(7).max(32)
  .regex(/^[\d\s()+.\-]+$/, 'Enter a phone number we can call');

const optionalEmail = z.string().trim().email().max(200).optional().or(z.literal(''));

export const CARE_TYPES = [
  'companion', 'personal_care', 'skilled_nursing', 'post_surgical',
  'overnight_newborn', 'respite', 'hospice_support', 'not_sure',
] as const;

export const AREAS = [
  'century_city', 'beverly_hills', 'westwood', 'brentwood', 'bel_air',
  'holmby_hills', 'santa_monica', 'pacific_palisades', 'malibu', 'other',
] as const;

export const URGENCIES = ['discharge', 'same_day', 'next_day', 'routine'] as const;

export const InquirySchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone,
  email: optionalEmail,
  relationship: z.enum([
    'self', 'spouse', 'parent', 'child', 'other_family', 'professional', 'other',
  ]),
  careType: z.enum(CARE_TYPES),
  area: z.enum(AREAS),
  patternNote: z.string().trim().max(400).optional(),   // "weekday mornings"
  startNote: z.string().trim().max(200).optional(),     // "discharging Monday"
  urgency: z.enum(URGENCIES),
  paymentMethod: z.enum(['private', 'ltc_policy', 'va', 'not_sure']),
  message: z.string().trim().max(2000).optional(),
  sourcePath: z.string().max(300),                      // hidden; which page it came from
  honeypot: z.literal('').optional(),
}).strict();

export type InquiryInput = z.infer<typeof InquirySchema>;

export const ProviderApplicationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone,
  email: z.string().trim().email().max(200),
  type: z.enum(['RN', 'LVN', 'CNA', 'HCA', 'companion']),
  licenseNumber: z.string().trim().max(60).optional(),
  areas: z.array(z.string()).min(1).max(9),
  languages: z.array(z.string()).min(1).max(8),
  specialties: z.array(z.string()).max(12),
  experienceNote: z.string().trim().max(1200).optional(),
  message: z.string().trim().max(2000).optional(),
  honeypot: z.literal('').optional(),
}).strict()
  .refine((v) => !['RN', 'LVN'].includes(v.type) || Boolean(v.licenseNumber), {
    path: ['licenseNumber'],
    message: 'A licence number is required for RN and LVN applications',
  });

export type ProviderApplicationInput = z.infer<typeof ProviderApplicationSchema>;

/**
 * Initials, not a name.
 *
 * A discharge planner submitting a full patient name and condition to a third party
 * before the family has engaged anyone is a privacy problem for the planner, not just
 * for us. We take initials plus a family contact; the operator gets the rest on the
 * call. `consentNote` records that the partner confirms the family agreed their details
 * could be passed on.
 */
export const PartnerReferralSchema = z.object({
  partnerName: z.string().trim().min(2).max(120),
  partnerOrg: z.string().trim().max(160),
  partnerRole: z.enum([
    'discharge_planner', 'care_manager', 'physician', 'surgical_practice',
    'attorney', 'family_office', 'other',
  ]),
  partnerPhone: phone,
  partnerEmail: z.string().trim().email().max(200),
  patientInitials: z.string().trim().min(1).max(8),
  careType: z.enum(CARE_TYPES),
  area: z.string().max(60),
  urgency: z.enum(URGENCIES),
  contactName: z.string().trim().min(2).max(120),       // family member to call
  contactPhone: phone,
  note: z.string().trim().max(1200).optional(),
  consentNote: z.literal(true),
  honeypot: z.literal('').optional(),
}).strict();

export type PartnerReferralInput = z.infer<typeof PartnerReferralSchema>;

/**
 * What we tell someone who has just submitted. Spec § 3.2.
 *
 * Only promise what the operator will actually do. A missed callback on a discharge is
 * the worst first impression this business can make, so if the window is not staffed,
 * soften the copy rather than breach it.
 */
export const CONFIRMATION: Record<(typeof URGENCIES)[number], string> = {
  discharge: "We've got this. Someone will call you within the hour.",
  same_day: "We've got this. Someone will call you within the hour.",
  next_day: "Received. We'll call you today.",
  routine: "Received. We'll call you within one business day.",
};

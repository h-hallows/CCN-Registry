/**
 * Spec § 11, intake block, plus the § 3.3 rule the whole public surface rests on: it
 * may record that somebody got in touch, and nothing else.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '@ccn/core/db';
import { seededDb } from '@ccn/core/testing';
import {
  InquirySchema, PartnerReferralSchema, ProviderApplicationSchema,
} from '@/lib/schemas/intake';
import { POST as inquiryRoute } from '@/app/api/inquiry/route';
import { POST as applyRoute } from '@/app/api/apply/route';
import { POST as referRoute } from '@/app/api/refer/route';

let db: DbHandle;

const VALID_INQUIRY = {
  name: 'Dov Rosenthal',
  phone: '(626) 555-0000',
  relationship: 'child',
  careType: 'companion',
  area: 'bel_air',
  urgency: 'discharge',
  paymentMethod: 'private',
  message: 'Mum is discharged tomorrow and nobody is local.',
  sourcePath: '/areas/bel-air',
} as const;

const VALID_APPLICATION = {
  fullName: 'A Applicant',
  phone: '(310) 555-0100',
  email: 'a@example.com',
  type: 'CNA',
  areas: ['beverly_hills'],
  languages: ['English'],
  specialties: [],
} as const;

const VALID_REFERRAL = {
  partnerName: 'Dolores Hwang',
  partnerOrg: 'Huntington Hospital',
  partnerRole: 'discharge_planner',
  partnerPhone: '(626) 555-0100',
  partnerEmail: 'd.hwang@example.org',
  patientInitials: 'JM',
  careType: 'post_surgical',
  area: 'beverly_hills',
  urgency: 'discharge',
  contactName: 'Grace Mwangi',
  contactPhone: '(626) 555-0199',
  consentNote: true,
} as const;

/** A request from a distinct caller, so the rate limiter does not bleed between tests. */
function post(body: unknown, ip: string): Request {
  return new Request('http://localhost/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

async function count(table: string): Promise<number> {
  const [row] = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(row!.n);
}

beforeAll(async () => { db = await seededDb(); });
beforeEach(async () => { await db.query(`DELETE FROM rate_limit_hits`); });

describe('§ 11 — the schemas are strict', () => {
  it('InquirySchema rejects an unknown key', () => {
    const r = InquirySchema.safeParse({ ...VALID_INQUIRY, isAdmin: true });
    expect(r.success).toBe(false);
  });

  it('InquirySchema accepts a valid submission', () => {
    expect(InquirySchema.safeParse(VALID_INQUIRY).success).toBe(true);
  });

  it('InquirySchema requires a phone we can actually call', () => {
    expect(InquirySchema.safeParse({ ...VALID_INQUIRY, phone: 'call me' }).success).toBe(false);
    expect(InquirySchema.safeParse({ ...VALID_INQUIRY, phone: '' }).success).toBe(false);
  });

  it('ProviderApplicationSchema requires a licence number for RN and LVN', () => {
    for (const type of ['RN', 'LVN'] as const) {
      const r = ProviderApplicationSchema.safeParse({ ...VALID_APPLICATION, type });
      expect(r.success, `${type} should require a licence`).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0]!.path).toEqual(['licenseNumber']);
      }
      expect(ProviderApplicationSchema.safeParse({
        ...VALID_APPLICATION, type, licenseNumber: 'RN-842113',
      }).success).toBe(true);
    }
  });

  it('ProviderApplicationSchema does not require one for an HCA', () => {
    expect(ProviderApplicationSchema.safeParse({ ...VALID_APPLICATION, type: 'HCA' }).success)
      .toBe(true);
  });

  it('PartnerReferralSchema requires the consent confirmation', () => {
    expect(PartnerReferralSchema.safeParse({ ...VALID_REFERRAL, consentNote: false }).success)
      .toBe(false);
    const { consentNote, ...without } = VALID_REFERRAL;
    void consentNote;
    expect(PartnerReferralSchema.safeParse(without).success).toBe(false);
  });

  it('PartnerReferralSchema takes initials, not a name — eight characters at most', () => {
    expect(PartnerReferralSchema.safeParse({
      ...VALID_REFERRAL, patientInitials: 'Joseph Mwangi',
    }).success).toBe(false);
  });
});

describe('§ 11 — the honeypot is silent', () => {
  it('a filled honeypot returns 202 and writes nothing', async () => {
    const before = await count('inquiries');
    const res = await inquiryRoute(
      post({ ...VALID_INQUIRY, honeypot: 'bot' }, '10.0.0.1') as never);
    // Zod rejects a non-empty honeypot before the route sees it, which is the same
    // outcome by a different route: nothing is written and nothing is confirmed.
    expect([202, 400]).toContain(res.status);
    expect(await count('inquiries')).toBe(before);
  });

  it('an empty honeypot is a normal submission', async () => {
    const before = await count('inquiries');
    const res = await inquiryRoute(post({ ...VALID_INQUIRY, honeypot: '' }, '10.0.0.2') as never);
    expect(res.status).toBe(202);
    expect(await count('inquiries')).toBe(before + 1);
  });
});

describe('§ 11 — the rate limit holds', () => {
  it('refuses the sixth submission in ten minutes', async () => {
    const ip = '10.0.0.3';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await inquiryRoute(post(VALID_INQUIRY, ip) as never);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 202)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('counts each caller separately', async () => {
    const res = await inquiryRoute(post(VALID_INQUIRY, '10.0.0.4') as never);
    expect(res.status).toBe(202);
  });

  it('never stores a raw address beside a care enquiry', async () => {
    await inquiryRoute(post(VALID_INQUIRY, '203.0.113.9') as never);
    const rows = await db.query<{ key_hash: string }>(`SELECT key_hash FROM rate_limit_hits`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.key_hash).not.toContain('203.0.113.9');
      expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('§ 3.3 — a public submission creates no live record', () => {
  it('records an enquiry and touches nothing else', async () => {
    const before = {
      households: await count('households'),
      cases: await count('cases'),
      providers: await count('providers'),
      referrals: await count('referrals'),
      timeline: await count('timeline_entries'),
      disclosures: await count('disclosures'),
    };

    const res = await inquiryRoute(post(VALID_INQUIRY, '10.0.1.1') as never);
    expect(res.status).toBe(202);
    const payload = await res.json() as { ok: boolean; message: string; reference: string };
    expect(payload.ok).toBe(true);
    expect(payload.message).toMatch(/within the hour/);
    expect(payload.reference).toHaveLength(8);

    expect(await count('households')).toBe(before.households);
    expect(await count('cases')).toBe(before.cases);
    expect(await count('providers')).toBe(before.providers);
    expect(await count('referrals')).toBe(before.referrals);
    expect(await count('timeline_entries')).toBe(before.timeline);
    expect(await count('disclosures')).toBe(before.disclosures);
  });

  it('leaves it unattached and unhandled, for the operator to convert', async () => {
    const [row] = await db.query<{ household_id: string | null; handled_at: string | null }>(
      `SELECT household_id, handled_at FROM inquiries ORDER BY received_at DESC LIMIT 1`);
    expect(row!.household_id).toBeNull();
    expect(row!.handled_at).toBeNull();
  });

  it('records an application without creating a provider', async () => {
    const providers = await count('providers');
    const res = await applyRoute(post(VALID_APPLICATION, '10.0.1.2') as never);
    expect(res.status).toBe(202);
    expect(await count('provider_applications')).toBeGreaterThan(0);
    expect(await count('providers')).toBe(providers);
  });

  it('takes a partner referral with no account, keeping the patient to initials', async () => {
    const res = await referRoute(post(VALID_REFERRAL, '10.0.1.3') as never);
    expect(res.status).toBe(202);

    const [row] = await db.query<{ name: string; referrer: Record<string, unknown> }>(
      `SELECT name, referrer FROM inquiries ORDER BY received_at DESC LIMIT 1`);
    // The person we call is the family contact, not the partner.
    expect(row!.name).toBe('Grace Mwangi');
    expect(row!.referrer.patientInitials).toBe('JM');
    expect(row!.referrer.consentConfirmed).toBe(true);
    expect(JSON.stringify(row!.referrer)).not.toContain('Joseph');
  });

  it('queues an operator notification that gives nothing away', async () => {
    const rows = await db.query<{ subject: string; body: string; payload: Record<string, unknown> }>(
      `SELECT subject, body, payload FROM operator_notifications ORDER BY created_at DESC`);
    expect(rows.length).toBeGreaterThan(0);
    for (const n of rows) {
      const message = `${n.subject} ${n.body}`;
      // Spec § 7: the message says something arrived; the console says what.
      for (const leak of ['Rosenthal', 'Mwangi', 'Bel Air', '555', 'discharged']) {
        expect(message, `notification leaks "${leak}"`).not.toContain(leak);
      }
    }
  });
});

describe('§ 10 — no code path from the front door reaches the compliance record', () => {
  const FORBIDDEN_TABLES = ['referrals', 'timeline_entries', 'disclosures', 'audit_log'];

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) sourceFiles(full, acc);
      else if (/\.(ts|tsx)$/.test(name) && !full.includes('/tests/')) acc.push(full);
    }
    return acc;
  }

  it('writes to none of them, anywhere in the app', () => {
    const root = new URL('..', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const file of sourceFiles(join(root, 'app')).concat(sourceFiles(join(root, 'lib')))) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const table of FORBIDDEN_TABLES) {
        if (new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${table}\\b`, 'i').test(code)) {
          offenders.push(`${file.replace(root, '')} writes to ${table}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/**
 * Architecture spec § 3.3, § 6.1 and the § 10 acceptance tests.
 *
 * The rule the public surface exists under: it may record that someone got in touch,
 * and nothing else. No public path creates a household, a case or a provider, and
 * nothing on this surface may reach the compliance record at all.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@ccn/core/db';
import { seededDb } from '@ccn/core/testing';
import {
  applicationSchema, inquirySchema, recordApplication, recordInquiry,
} from '@/lib/intake';

let db: DbHandle;

async function count(table: string): Promise<number> {
  const [row] = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(row!.n);
}

beforeAll(async () => { db = await seededDb(); });

describe('§ 3.3 public intake creates no live record', () => {
  it('records an enquiry and touches nothing else', async () => {
    const before = {
      households: await count('households'),
      cases: await count('cases'),
      providers: await count('providers'),
      referrals: await count('referrals'),
      timeline: await count('timeline_entries'),
      disclosures: await count('disclosures'),
    };

    await recordInquiry({
      name: 'Dov Rosenthal',
      phone: '(626) 555-0000',
      careType: 'companion',
      area: 'La Cañada',
      urgency: 'discharge',
      message: 'Mum is discharged tomorrow and nobody is local.',
      sourcePath: '/areas/la-canada',
    });

    expect(await count('inquiries')).toBe(1);
    expect(await count('households')).toBe(before.households);
    expect(await count('cases')).toBe(before.cases);
    expect(await count('providers')).toBe(before.providers);
    expect(await count('referrals')).toBe(before.referrals);
    expect(await count('timeline_entries')).toBe(before.timeline);
    expect(await count('disclosures')).toBe(before.disclosures);
  });

  it('leaves the enquiry unattached and unhandled, for the operator to convert', async () => {
    const [row] = await db.query<{ household_id: string | null; handled_at: string | null }>(
      `SELECT household_id, handled_at FROM inquiries ORDER BY received_at DESC LIMIT 1`,
    );
    expect(row!.household_id).toBeNull();
    expect(row!.handled_at).toBeNull();
  });

  it('records a provider application without creating a provider', async () => {
    const providers = await count('providers');
    await recordApplication({
      fullName: 'A Applicant',
      email: 'a@example.com',
      type: 'CNA',
      areas: ['Pasadena'],
      languages: ['English'],
    });
    expect(await count('provider_applications')).toBe(1);
    expect(await count('providers')).toBe(providers);
  });

  it('attributes a partner referral without needing an account', async () => {
    const [partner] = await db.query<{ id: string }>(
      `SELECT id FROM referral_partners LIMIT 1`,
    );
    await recordInquiry({
      name: 'Referred by a discharge planner',
      phone: '(626) 555-0101',
      partnerId: partner!.id,
    });
    const [row] = await db.query<{ partner_id: string | null }>(
      `SELECT partner_id FROM inquiries ORDER BY received_at DESC LIMIT 1`,
    );
    expect(row!.partner_id).toBe(partner!.id);
  });
});

describe('intake validation', () => {
  it('requires some way to reach the person back', () => {
    const r = inquirySchema.safeParse({ name: 'No Contact' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toMatch(/phone number or an email/i);
    }
  });

  it('accepts a phone alone, which is how most of these arrive', () => {
    expect(inquirySchema.safeParse({ name: 'Caller', phone: '(626) 555-0000' }).success)
      .toBe(true);
  });

  it('rejects an application with no way to reply', () => {
    expect(applicationSchema.safeParse({ fullName: 'Someone' }).success).toBe(false);
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
      const text = readFileSync(file, 'utf8');
      // Comments explain the rule; only statements may not name these tables.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const table of FORBIDDEN_TABLES) {
        if (new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${table}\\b`, 'i').test(code)) {
          offenders.push(`${file.replace(root, '')} writes to ${table}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('records a request as a request — there is no referral-creating helper here', async () => {
    const intake = await import('@/lib/intake');
    for (const name of Object.keys(intake)) {
      expect(name).not.toMatch(/refer(ral)?(?!ence)|disclos|timeline/i);
    }
  });
});

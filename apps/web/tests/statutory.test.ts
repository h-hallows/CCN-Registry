/**
 * Architecture spec § 6.5 — the statutory footer cannot be removed from a page, and
 * cannot ship unapproved.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_STATUTORY_TEXTS, isApproved, REFERRAL_AGENCY_STATEMENT } from '@/content/statutory';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('the footer is structural, not per-page', () => {
  it('is rendered by the marketing layout, so no page can omit it', () => {
    const layout = read('../app/(marketing)/layout.tsx');
    expect(layout).toContain('StatutoryFooter');
  });

  it('is not rendered by individual pages, which is how it would drift', () => {
    const page = read('../app/(marketing)/page.tsx');
    expect(page).not.toContain('StatutoryFooter');
  });

  it('imports its text rather than retyping it', () => {
    const footer = read('../components/StatutoryFooter.tsx');
    expect(footer).toContain("from '@/content/statutory'");
    // The statement itself must not be inlined in the component.
    expect(footer).not.toMatch(/registry (?:refers|does not employ)/i);
  });

  it('fails a production deploy while the text is unapproved', () => {
    const footer = read('../components/StatutoryFooter.tsx');
    // VERCEL_ENV, not NODE_ENV: NODE_ENV is 'production' for every build, including a
    // local one, and gating those would stop work rather than stop shipping.
    expect(footer).toContain("process.env.VERCEL_ENV === 'production'");
    expect(footer).not.toContain("process.env.NODE_ENV === 'production'");
    expect(footer).toContain('throw new Error');
  });

  it('still renders something unmissable outside production', () => {
    const footer = read('../components/StatutoryFooter.tsx');
    expect(footer).toContain('data-statutory-footer="placeholder"');
  });
});

describe('the statutory texts', () => {
  it('are all still awaiting counsel, and say so rather than pretending', () => {
    // This test flips when counsel supplies the texts. Until then it documents, in the
    // suite rather than in a comment, that the front door cannot ship.
    for (const t of ALL_STATUTORY_TEXTS) {
      if (t.status === 'approved') {
        expect(t.text.trim().length, 'an approved text cannot be empty').toBeGreaterThan(0);
        expect(t.version).not.toBe('0');
      } else {
        expect(t.text).toBe('');
        expect(t.purpose.length).toBeGreaterThan(20);
      }
    }
  });

  it('never advertises the bond or a licence — § 1812.5095(i)–(j)', () => {
    for (const t of ALL_STATUTORY_TEXTS) {
      const lowered = t.text.toLowerCase();
      for (const banned of ['surety bond', 'bonded and insured', 'licensed and bonded']) {
        expect(lowered).not.toContain(banned);
      }
    }
  });

  it('reports the footer statement as not shippable', () => {
    expect(isApproved(REFERRAL_AGENCY_STATEMENT)).toBe(false);
  });
});

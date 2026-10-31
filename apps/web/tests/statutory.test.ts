/**
 * Spec § 11, statutory block.
 *
 * The two verbatim texts are asserted character for character against the statute as
 * quoted in the build spec. That is a deliberate second copy: these are the operative
 * legal artifacts of the business, and the whole point is that an edit — a tidied
 * comma, a softened phrase — fails the build rather than reaching a household.
 *
 * This file is outside content/statutory/, so the lint's exception does not cover it.
 * It can quote the statute because tests are not linted copy.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALL_STATUTORY_TEXTS, BUSINESS_CONTACT, COMPLAINT_CONTACTS, contactsComplete,
  isDeliverable, NURSES_REGISTRY_DISCLOSURE, ORAL_DISCLOSURE, PROVIDER_NOTICE,
  REFERRAL_AGENCY_LINE, WRITTEN_STATEMENT, WRITTEN_STATEMENT_MIN_POINT,
} from '@/content/statutory';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const ORAL_VERBATIM =
  'Century City Concierge Nursing is not the employer of the domestic worker it '
  + 'referred to you. Depending on your arrangement with the domestic worker, you may '
  + 'have employer responsibilities.';

const WRITTEN_VERBATIM =
  'Century City Concierge Nursing is not the employer of the domestic worker it '
  + 'referred to you. The domestic worker may be your employee or an independent '
  + 'contractor depending on the relationship you have with him or her. If you direct '
  + 'and control the manner and means by which the domestic worker performs his or her '
  + "work you may have employer responsibilities, including employment taxes and "
  + "workers' compensation, under state and federal law. For additional information "
  + 'contact your local Employment Development Department and the Internal Revenue '
  + 'Service.';

describe('the verbatim statutory texts', () => {
  it('oral disclosure matches § 1812.5095(f) first paragraph exactly', () => {
    expect(ORAL_DISCLOSURE.text).toBe(ORAL_VERBATIM);
    expect(ORAL_DISCLOSURE.status).toBe('statute');
  });

  it('written statement matches § 1812.5095(f) second paragraph exactly', () => {
    expect(WRITTEN_STATEMENT.text).toBe(WRITTEN_VERBATIM);
    expect(WRITTEN_STATEMENT.status).toBe('statute');
  });

  it('keeps the statutory labels the statute uses, which CCN\'s own copy may not', () => {
    // § 1812.5095(g) bars CCN from these labels; § 1812.5095(f) requires this sentence.
    expect(WRITTEN_STATEMENT.text).toContain('independent contractor');
  });
});

describe('version discipline', () => {
  it('every statutory text carries a VERSION and a LAST_REVIEWED', () => {
    for (const t of ALL_STATUTORY_TEXTS) {
      expect(t.VERSION, t.citation).toMatch(/^\d+$/);
      expect(t.LAST_REVIEWED, t.citation).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.citation.length, t.citation).toBeGreaterThan(5);
    }
  });

  it('every file in the directory is exported, so none can be forgotten', () => {
    const dir = new URL('../content/statutory/', import.meta.url);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !['index.ts', 'types.ts'].includes(f));
    const index = read('../content/statutory/index.ts');
    for (const f of files) {
      expect(index, `${f} is not re-exported from index.ts`).toContain(f.replace('.ts', ''));
    }
  });
});

describe('what is not yet deliverable', () => {
  it('the drafted texts are marked draft, so they cannot be delivered', () => {
    expect(NURSES_REGISTRY_DISCLOSURE.status).toBe('draft');
    expect(PROVIDER_NOTICE.status).toBe('draft');
    expect(isDeliverable(NURSES_REGISTRY_DISCLOSURE)).toBe(false);
    expect(isDeliverable(PROVIDER_NOTICE)).toBe(false);
  });

  it('the complaint contacts are unfilled — a guessed address sends a complaint nowhere', () => {
    expect(contactsComplete()).toBe(false);
    expect(COMPLAINT_CONTACTS.length).toBe(2);
  });

  it('no statutory text advertises the bond or a licence — § 1812.5095(i)–(j)', () => {
    for (const t of ALL_STATUTORY_TEXTS) {
      const lowered = t.text.toLowerCase();
      for (const banned of ['surety', 'bonded', 'licensed and', 'accredit']) {
        expect(lowered, t.citation).not.toContain(banned);
      }
    }
  });
});

describe('the footer carries both required lines', () => {
  it('is rendered by the marketing layout, so no page can omit it', () => {
    expect(read('../app/(marketing)/layout.tsx')).toContain('StatutoryFooter');
  });

  it('is not rendered by individual pages, which is how it would drift', () => {
    expect(read('../app/(marketing)/page.tsx')).not.toContain('StatutoryFooter');
  });

  it('renders the § 1812.5095(h) line and the § 1812.533(b)(2) contact', () => {
    const footer = read('../components/StatutoryFooter.tsx');
    expect(footer).toContain('REFERRAL_AGENCY_LINE.text');
    expect(footer).toContain('BUSINESS_CONTACT.text');
  });

  it('imports its text rather than retyping it', () => {
    const footer = read('../components/StatutoryFooter.tsx');
    expect(footer).toContain("from '@/content/statutory'");
    // Comments quote the statute to explain the rule; only the code may not inline it.
    const code = footer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('is a referral agency.');
  });

  it('fails a production deploy while either line is missing', () => {
    const footer = read('../components/StatutoryFooter.tsx');
    expect(footer).toContain("process.env.VERCEL_ENV === 'production'");
    expect(footer).not.toContain("process.env.NODE_ENV === 'production'");
    expect(footer).toContain('throw new Error');
  });

  it('cannot ship today: the business contact is unfilled', () => {
    expect(BUSINESS_CONTACT.status).toBe('unfilled');
    expect(isDeliverable(BUSINESS_CONTACT)).toBe(false);
    expect(isDeliverable(REFERRAL_AGENCY_LINE)).toBe(true);
  });
});

describe('point sizes are absolute, not inherited', () => {
  const css = read('../app/globals.css');

  it('the written statement is at least 10 point — § 1812.5095(f)', () => {
    expect(WRITTEN_STATEMENT_MIN_POINT).toBe(10);
    const match = /\.statutory-written-statement\s*\{[^}]*font-size:\s*(\d+)pt/.exec(css);
    expect(match, 'no absolute pt size declared for the written statement').toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(WRITTEN_STATEMENT_MIN_POINT);
  });

  it('the footer is at least 6 point — § 1812.5095(h)', () => {
    const match = /\.statutory\s*\{[^}]*font-size:\s*(\d+)pt/.exec(css);
    expect(match, 'no absolute pt size declared for the footer').toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(6);
  });

  it('declares them in points, not rem — a rem can inherit smaller down a nesting chain', () => {
    expect(css).not.toMatch(/\.statutory\s*\{[^}]*font-size:\s*[\d.]+rem/);
  });
});

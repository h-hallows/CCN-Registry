/** Site-level facts the metadata routes share. */

/**
 * The canonical origin. Falls back to a localhost default so a build without the
 * variable still produces valid absolute URLs rather than `undefined/sitemap.xml`.
 */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return 'http://localhost:3003';
}

type ChangeFrequency = 'yearly' | 'monthly' | 'weekly' | 'daily';

export const MARKETING_ROUTES: {
  path: string; priority: number; changeFrequency: ChangeFrequency;
}[] = [
  { path: '/', priority: 1.0, changeFrequency: 'monthly' },
  { path: '/how-it-works', priority: 0.9, changeFrequency: 'monthly' },
  { path: '/pricing', priority: 0.9, changeFrequency: 'weekly' },
  { path: '/vetting', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/for-providers', priority: 0.7, changeFrequency: 'monthly' },
  { path: '/for-partners', priority: 0.7, changeFrequency: 'monthly' },
];

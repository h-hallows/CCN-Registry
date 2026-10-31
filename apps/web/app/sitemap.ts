import type { MetadataRoute } from 'next';
import { MARKETING_ROUTES, siteUrl } from '@/lib/site';

/** Only the marketing routes. A portal in a sitemap is an invitation to crawl it. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return MARKETING_ROUTES.map(({ path, priority, changeFrequency }) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency,
    priority,
  }));
}

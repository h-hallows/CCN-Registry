import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site';

/**
 * Spec § 8. The marketing pages are indexable; the portals never are.
 *
 * A robots.txt disallow is a request. The `X-Robots-Tag` header in next.config.ts is
 * the instruction, and both are set — this file stops a crawler fetching, the header
 * stops it indexing what it fetched anyway.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{
      userAgent: '*',
      allow: '/',
      disallow: ['/portal', '/pro', '/partner', '/invite', '/api'],
    }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}

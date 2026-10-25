import type { MetadataRoute } from 'next';

/**
 * Architecture spec § 7: the console disallows all crawlers.
 *
 * This is belt to the braces of the `X-Robots-Tag: noindex, nofollow, noarchive` header
 * in next.config.ts, which is the one that actually binds — robots.txt asks a crawler not
 * to fetch, the header tells it not to index what it fetched anyway. Neither is a security
 * control: the vercel.app host is guessable, and until a real auth gate is in front of it
 * this file is a courtesy, not a defence.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  };
}

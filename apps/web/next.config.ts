import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  transpilePackages: ['@ccn/core'],

  /**
   * Architecture spec § 6.2 and § 7. The marketing routes are indexable; the three
   * portals never are. This is the inverse of the console, which is noindex everywhere.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      ...['/portal/:path*', '/pro/:path*', '/partner/:path*', '/invite/:path*'].map((source) => ({
        source,
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
        ],
      })),
    ];
  },
};

export default nextConfig;

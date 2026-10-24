import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  /**
   * Both database drivers load native or WASM assets at runtime and must not be bundled:
   * webpack's browser `fs` shim is what they get otherwise, and PGlite then fails to open
   * its data directory.
   */
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  // The data here is health-adjacent information about private individuals.
  // No public surface in V1 (§ 9), so nothing is indexable and nothing is cached.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
        ],
      },
    ];
  },
};

export default nextConfig;

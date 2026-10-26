import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  /**
   * Both database drivers load native or WASM assets at runtime and must not be bundled:
   * webpack's browser `fs` shim is what they get otherwise, and PGlite then fails to open
   * its data directory.
   */
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  // @ccn/core ships TypeScript source with no build step (architecture spec § 2.2), so
  // Next has to compile it rather than treat it as a prebuilt dependency.
  transpilePackages: ['@ccn/core'],
  /**
   * The migration SQL files are read at runtime by lib/db/migrate.ts, which /api/health
   * uses to report which migrations are pending. Next traces imports, not readdir calls,
   * so without this the directory is simply absent from the deployed bundle and the
   * health route throws before it can report anything.
   */
  outputFileTracingIncludes: {
    '/api/health': ['../../packages/core/migrations/**/*.sql'],
  },
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

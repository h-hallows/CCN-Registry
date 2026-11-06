import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  /**
   * Both database drivers load native or WASM assets at runtime and must not be bundled:
   * webpack's browser `fs` shim is what they get otherwise, and PGlite then fails to open
   * its data directory.
   */
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  /**
   * Documents are filed through a server action, and the default body limit for one is
   * 1 MB. The database's own ceiling is 10 MB (migration 0015), and the two disagreeing
   * would mean a scanned agreement failing with a framework error rather than with the
   * message `fileDocument` writes.
   */
  experimental: { serverActions: { bodySizeLimit: '11mb' } },
  // @h-hallows/core ships TypeScript source with no build step (architecture spec § 2.2), so
  // Next has to compile it rather than treat it as a prebuilt dependency.
  transpilePackages: ['@h-hallows/core'],
  /**
   * The migration SQL files are read at runtime by lib/db/migrate.ts, which /api/health
   * uses to report which migrations are pending. Next traces imports, not readdir calls,
   * so without this the directory is simply absent from the deployed bundle and the
   * health route throws before it can report anything.
   */
  outputFileTracingIncludes: {
    // core is a git dependency now, not a workspace package. The old
    // ../../packages/core path has not existed since the split, so a deployed build
    // could not read its own migration list and /api/health reported schema
    // 'unknown' — the one thing that route exists to get right.
    '/api/health': ['./node_modules/@h-hallows/core/migrations/**/*.sql'],
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

/**
 * The production database guard.
 *
 * This exists because of a real incident: the console deployed with no DATABASE_URL,
 * silently fell back to embedded PGlite on a read-only serverless filesystem, and the
 * only symptom was a 500 on /login/verify — three clicks from the cause, on the one route
 * that happened to touch the database first.
 */
import { describe, expect, it } from 'vitest';
import {
  ConfigError, describeConnection, resolveDatabaseConfig, resolveMigrationConfig,
} from '@/lib/env';

const REMOTE = 'postgres://u:secret@db.example.com:5432/ccn?sslmode=require';
const POOLED = 'postgres://u:secret@db.example.com:6543/ccn?sslmode=require';

describe('resolveDatabaseConfig', () => {
  it('uses DATABASE_URL whenever one is set', () => {
    expect(resolveDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: REMOTE }))
      .toEqual({ driver: 'postgres', url: REMOTE });
  });

  it('falls back to the embedded database in development', () => {
    expect(resolveDatabaseConfig({ NODE_ENV: 'development' })).toEqual({ driver: 'pglite' });
    expect(resolveDatabaseConfig({ NODE_ENV: 'test' })).toEqual({ driver: 'pglite' });
  });

  it('refuses to fall back in production', () => {
    expect(() => resolveDatabaseConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
  });

  it('treats an empty or whitespace DATABASE_URL as unset', () => {
    expect(() => resolveDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: '   ' }))
      .toThrow(ConfigError);
    expect(resolveDatabaseConfig({ NODE_ENV: 'development', DATABASE_URL: '' }))
      .toEqual({ driver: 'pglite' });
  });

  it('names what to set, so the message is actionable from a log line alone', () => {
    try {
      resolveDatabaseConfig({ NODE_ENV: 'production' });
      throw new Error('expected a ConfigError');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('npm run db:deploy');
    }
  });

  it('offers no escape hatch — a flag to re-enable the fallback would be set once and forgotten', () => {
    expect(() => resolveDatabaseConfig({
      NODE_ENV: 'production',
      ...{ ALLOW_EMBEDDED_DB: '1', PGLITE_DIR: '/tmp/x' },
    } as never)).toThrow(ConfigError);
  });
});

describe('resolveMigrationConfig', () => {
  it('prefers DIRECT_URL, because a pooler cannot run migration 0001', () => {
    expect(resolveMigrationConfig({ DATABASE_URL: POOLED, DIRECT_URL: REMOTE }))
      .toEqual({ driver: 'postgres', url: REMOTE });
  });

  it('falls back to DATABASE_URL when no direct connection is given', () => {
    expect(resolveMigrationConfig({ DATABASE_URL: POOLED }))
      .toEqual({ driver: 'postgres', url: POOLED });
  });

  it('applies the same production rule', () => {
    expect(() => resolveMigrationConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(resolveMigrationConfig({ NODE_ENV: 'development' })).toEqual({ driver: 'pglite' });
  });
});

describe('describeConnection', () => {
  it('names the host and database and never the password', () => {
    const described = describeConnection(REMOTE);
    expect(described).toBe('db.example.com:5432/ccn');
    expect(described).not.toContain('secret');
    expect(described).not.toContain('u:');
  });

  it('does not throw on a malformed connection string', () => {
    expect(describeConnection('not a url')).toBe('an unparseable connection string');
  });
});

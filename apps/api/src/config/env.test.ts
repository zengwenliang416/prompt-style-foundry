import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './env.js';

function envWith(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...values };
}

describe('loadConfig (catalog-only / direct-byok defaults)', () => {
  it('applies safe defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'info',
      runMode: 'catalog-only',
    });
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig(envWith({ RUN_MODE: '', PORT: '  ' }));
    expect(config.runMode).toBe('catalog-only');
    expect(config.port).toBe(8080);
  });

  it('rejects a non-integer port with the offending value', () => {
    expect(() => loadConfig({ PORT: 'notaport' })).toThrow(ConfigError);
    try {
      loadConfig({ PORT: 'notaport' });
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]?.field).toBe('PORT');
      expect(issues[0]?.problem).toContain('notaport');
    }
  });

  it('rejects port out of range', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects unknown run modes', () => {
    expect(() => loadConfig({ RUN_MODE: 'bogus' })).toThrow(/RUN_MODE/);
  });

  it('rejects unknown log levels', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('accepts explicit valid values', () => {
    const config = loadConfig({
      HOST: '0.0.0.0',
      PORT: '9443',
      LOG_LEVEL: 'debug',
      RUN_MODE: 'direct-byok',
    });
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 9443,
      logLevel: 'debug',
      runMode: 'direct-byok',
    });
  });
});

describe('loadConfig (managed-generation gate)', () => {
  const validManaged = {
    RUN_MODE: 'managed-generation',
    DATABASE_URL: 'postgresql://svc:placeholderpw@localhost:5432/onepic',
    OIDC_ISSUER: 'https://id.example.com',
    OIDC_CLIENT_ID: 'onepic-api',
    OIDC_CLIENT_SECRET: 'placeholder-secret-value-000000000001',
    OIDC_REDIRECT_URI: 'https://api.example.com/api/v1/auth/callback',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };

  it('refuses to start without any identity configuration (ADR 0001 D-4)', () => {
    try {
      loadConfig({ RUN_MODE: 'managed-generation' });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const fields = (error as ConfigError).issues.map((i) => i.field);
      expect(fields).toEqual([
        'DATABASE_URL',
        'OIDC_ISSUER',
        'OIDC_CLIENT_ID',
        'OIDC_CLIENT_SECRET',
        'OIDC_REDIRECT_URI',
        'SESSION_SECRET',
      ]);
    }
  });

  it('never echoes secret values in issues', () => {
    try {
      loadConfig({ RUN_MODE: 'managed-generation', DATABASE_URL: validManaged['DATABASE_URL'] });
    } catch (error) {
      const text = JSON.stringify((error as ConfigError).issues);
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('placeholderpw');
    }
  });

  it('rejects a session secret shorter than 32 characters without echoing it', () => {
    try {
      loadConfig({ ...validManaged, SESSION_SECRET: 'too-short' });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues.map((i) => i.field)).toContain('SESSION_SECRET');
      expect(JSON.stringify(issues)).not.toContain('too-short');
    }
  });

  it('rejects a malformed database URL without echoing it', () => {
    try {
      loadConfig({ ...validManaged, DATABASE_URL: 'not-a-url' });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues.map((i) => i.field)).toContain('DATABASE_URL');
      expect(JSON.stringify(issues)).not.toContain('not-a-url');
    }
  });

  it('rejects a non-postgres database URL scheme without echoing it', () => {
    try {
      loadConfig({ ...validManaged, DATABASE_URL: 'mysql://user:pw@localhost/db' });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const issues = (error as ConfigError).issues;
      expect(issues.map((i) => i.field)).toContain('DATABASE_URL');
    }
  });

  it('accepts http:// only for loopback OIDC issuers', () => {
    const loopback = loadConfig({
      ...validManaged,
      OIDC_ISSUER: 'http://localhost:8080/realms/test',
    });
    expect(loopback.oidcIssuer).toBe('http://localhost:8080/realms/test');

    expect(() => loadConfig({ ...validManaged, OIDC_ISSUER: 'http://id.example.com' })).toThrow(
      /https/,
    );
  });

  it('accepts a fully configured managed setup', () => {
    const config = loadConfig(validManaged);
    expect(config.runMode).toBe('managed-generation');
    expect(config.sessionSecret).toHaveLength(64);
  });
});

describe('loadConfig (validates DATABASE_URL even outside managed mode)', () => {
  it('rejects a malformed database URL in catalog-only mode', () => {
    expect(() => loadConfig({ DATABASE_URL: 'not-a-url' })).toThrow(ConfigError);
  });
});

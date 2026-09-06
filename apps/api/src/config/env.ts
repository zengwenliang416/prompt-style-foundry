/**
 * Startup configuration for the API. Values come exclusively from the
 * process environment (12-factor); a missing or invalid value must fail
 * startup without printing secret material.
 *
 * Redaction policy: issues never embed the value of any field whose name
 * suggests a secret (SECRET/KEY/TOKEN/PASSWORD) or of DATABASE_URL, which
 * typically embeds credentials. Non-secret values may be echoed to ease
 * debugging. Checklist B03/B06 will consume the identity and readiness
 * fields; validation here is deliberately ahead of that wiring.
 */

export type RunMode = 'catalog-only' | 'direct-byok' | 'managed-generation';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface ApiConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  runMode: RunMode;
  /** Required for managed-generation; values are never logged. */
  databaseUrl?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcRedirectUri?: string;
  sessionSecret?: string;
  /** Private media storage root (local adapter); S3 adapter swaps in later. */
  mediaStorageRoot?: string;
}

export interface ConfigIssue {
  /** Environment variable name; safe to display. */
  field: string;
  /** Human-readable reason; never contains secret values. */
  problem: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((i) => `${i.field}: ${i.problem}`).join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const RUN_MODES: readonly RunMode[] = ['catalog-only', 'direct-byok', 'managed-generation'];
const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

const MANAGED_REQUIRED_FIELDS = [
  'DATABASE_URL',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'SESSION_SECRET',
] as const;

/**
 * Issue messages may echo values only for non-secret fields (PORT,
 * RUN_MODE, LOG_LEVEL). Secret-valued fields (DATABASE_URL, *_SECRET,
 * *_KEY, *_TOKEN) are validated through dedicated branches whose problem
 * strings never contain the raw value.
 */
function readString(source: NodeJS.ProcessEnv, field: string): string | undefined {
  const raw = source[field];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readPort(source: NodeJS.ProcessEnv, issues: ConfigIssue[]): number | undefined {
  const raw = readString(source, 'PORT');
  if (raw === undefined) {
    return undefined;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    issues.push({ field: 'PORT', problem: `must be an integer in [1, 65535], got "${raw}"` });
    return undefined;
  }
  return port;
}

function readRunMode(source: NodeJS.ProcessEnv, issues: ConfigIssue[]): RunMode | undefined {
  const raw = readString(source, 'RUN_MODE');
  if (raw === undefined) {
    return undefined;
  }
  if (!RUN_MODES.includes(raw as RunMode)) {
    issues.push({
      field: 'RUN_MODE',
      problem: `must be one of ${RUN_MODES.join(' | ')}, got "${raw}"`,
    });
    return undefined;
  }
  return raw as RunMode;
}

function readLogLevel(source: NodeJS.ProcessEnv, issues: ConfigIssue[]): LogLevel | undefined {
  const raw = readString(source, 'LOG_LEVEL');
  if (raw === undefined) {
    return undefined;
  }
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    issues.push({
      field: 'LOG_LEVEL',
      problem: `must be one of ${LOG_LEVELS.join(' | ')}, got "${raw}"`,
    });
    return undefined;
  }
  return raw as LogLevel;
}

/**
 * Issuer must be an HTTPS URL, except plain HTTP is tolerated for local
 * development/test identity providers on loopback hosts.
 */
function validateOidcIssuer(value: string, issues: ConfigIssue[]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push({ field: 'OIDC_ISSUER', problem: 'must be a valid URL' });
    return;
  }
  const isHttps = url.protocol === 'https:';
  const isLoopbackHttp =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!isHttps && !isLoopbackHttp) {
    issues.push({
      field: 'OIDC_ISSUER',
      problem: 'must use https:// (http:// is only allowed for localhost/loopback dev providers)',
    });
  }
}

function validateDatabaseUrl(value: string, issues: ConfigIssue[]): void {
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
      issues.push({
        field: 'DATABASE_URL',
        problem: 'must be a postgresql:// URL (value redacted)',
      });
    }
  } catch {
    issues.push({ field: 'DATABASE_URL', problem: 'must be a valid URL (value redacted)' });
  }
}

function validateSessionSecret(value: string, issues: ConfigIssue[]): void {
  if (value.length < 32) {
    issues.push({
      field: 'SESSION_SECRET',
      problem: 'must be at least 32 characters (value redacted)',
    });
  }
}

/**
 * Validates and normalizes the API environment. Throws {@link ConfigError}
 * with every detected issue (all secret values redacted) so operators can
 * fix everything in one round trip.
 */
export function loadConfig(source: NodeJS.ProcessEnv): ApiConfig {
  const issues: ConfigIssue[] = [];

  const port = readPort(source, issues) ?? 8080;
  const runMode = readRunMode(source, issues) ?? 'catalog-only';
  const logLevel = readLogLevel(source, issues) ?? 'info';
  const host = readString(source, 'HOST') ?? '127.0.0.1';
  const databaseUrl = readString(source, 'DATABASE_URL');
  const oidcIssuer = readString(source, 'OIDC_ISSUER');
  const oidcClientId = readString(source, 'OIDC_CLIENT_ID');
  const oidcClientSecret = readString(source, 'OIDC_CLIENT_SECRET');
  const oidcRedirectUri = readString(source, 'OIDC_REDIRECT_URI');
  const sessionSecret = readString(source, 'SESSION_SECRET');
  const mediaStorageRoot = readString(source, 'MEDIA_STORAGE_ROOT');

  if (runMode === 'managed-generation') {
    const present = new Set(
      MANAGED_REQUIRED_FIELDS.filter((field) => readString(source, field) !== undefined),
    );
    const missing = MANAGED_REQUIRED_FIELDS.filter((field) => !present.has(field));
    for (const field of missing) {
      issues.push({
        field,
        problem:
          'required when RUN_MODE=managed-generation (ADR 0001 D-4: managed mode refuses to start without a configured identity source)',
      });
    }
    if (oidcIssuer !== undefined) {
      validateOidcIssuer(oidcIssuer, issues);
    }
    if (databaseUrl !== undefined) {
      validateDatabaseUrl(databaseUrl, issues);
    }
    if (sessionSecret !== undefined) {
      validateSessionSecret(sessionSecret, issues);
    }
  } else if (databaseUrl !== undefined) {
    // Validate shape even when unused, so a typo cannot hide until mode switch.
    validateDatabaseUrl(databaseUrl, issues);
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    host,
    port,
    logLevel,
    runMode,
    databaseUrl,
    oidcIssuer,
    oidcClientId,
    oidcClientSecret,
    oidcRedirectUri,
    sessionSecret,
    mediaStorageRoot,
  };
}

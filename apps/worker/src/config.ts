export interface WorkerProviderModel {
  id: string;
  qualities: string[];
}

export interface WorkerConfig {
  databaseUrl?: string;
  mediaStorageRoot: string;
  cleanupIntervalSeconds: number;
  retention: {
    uploadIncompleteHours: number;
    inputMediaHours: number;
    resultMediaDays: number;
    generationDays: number;
    auditEventDays: number;
  };
  metricsHost: string;
  metricsPort?: number;
  generationEnabled: boolean;
  generation: {
    concurrency: number;
    pollIntervalMs: number;
    leaseSeconds: number;
    heartbeatSeconds: number;
    shutdownGraceMs: number;
  };
  provider?: {
    providerId: string;
    label: string;
    baseUrl: string;
    apiKey: string;
    models: WorkerProviderModel[];
  };
}

export interface WorkerConfigIssue {
  field: string;
  problem: string;
}

export class WorkerConfigError extends Error {
  readonly issues: WorkerConfigIssue[];

  constructor(issues: WorkerConfigIssue[]) {
    super(`Invalid worker configuration: ${issues.map((issue) => issue.field).join(', ')}`);
    this.name = 'WorkerConfigError';
    this.issues = issues;
  }
}

function readString(source: NodeJS.ProcessEnv, field: string): string | undefined {
  const value = source[field]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function readPositiveInt(
  source: NodeJS.ProcessEnv,
  field: string,
  fallback: number,
  issues: WorkerConfigIssue[],
): number {
  const raw = readString(source, field);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    issues.push({ field, problem: 'must be a positive integer' });
    return fallback;
  }
  return value;
}

function readBoolean(
  source: NodeJS.ProcessEnv,
  field: string,
  fallback: boolean,
  issues: WorkerConfigIssue[],
): boolean {
  const raw = readString(source, field);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  issues.push({ field, problem: 'must be true or false' });
  return fallback;
}

function parseModels(raw: string | undefined, issues: WorkerConfigIssue[]): WorkerProviderModel[] {
  if (raw === undefined) return [];
  const models: WorkerProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const [idPart, qualityPart, ...extra] = entry.split(':');
    const id = idPart?.trim() ?? '';
    const qualities = (qualityPart ?? '')
      .split('+')
      .map((quality) => quality.trim())
      .filter((quality) => quality !== '');
    if (
      extra.length > 0 ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(id) ||
      qualities.length === 0 ||
      qualities.some((quality) => !/^[a-zA-Z0-9._-]{1,64}$/.test(quality)) ||
      seen.has(id)
    ) {
      issues.push({
        field: 'WORKER_PROVIDER_MODELS',
        problem: 'must use unique model:quality+quality entries',
      });
      return [];
    }
    seen.add(id);
    models.push({ id, qualities: [...new Set(qualities)] });
  }
  return models;
}

function validateProviderBaseUrl(value: string, issues: WorkerConfigIssue[]): void {
  try {
    const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      issues.push({
        field: 'WORKER_PROVIDER_BASE_URL',
        problem: 'must use https (http is allowed only for loopback test providers)',
      });
    }
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      issues.push({
        field: 'WORKER_PROVIDER_BASE_URL',
        problem: 'must be an origin without credentials, path, query, or fragment',
      });
    }
  } catch {
    issues.push({ field: 'WORKER_PROVIDER_BASE_URL', problem: 'must be a valid URL' });
  }
}

/** Loads Worker settings without ever embedding secret values in issues/logs. */
export function loadWorkerConfig(source: NodeJS.ProcessEnv): WorkerConfig {
  const issues: WorkerConfigIssue[] = [];
  const databaseUrl = readString(source, 'DATABASE_URL');
  const generationEnabled = readBoolean(source, 'WORKER_GENERATION_ENABLED', false, issues);
  const concurrency = readPositiveInt(source, 'WORKER_CONCURRENCY', 2, issues);
  const pollIntervalMs = readPositiveInt(source, 'WORKER_POLL_INTERVAL_MS', 500, issues);
  const leaseSeconds = readPositiveInt(source, 'WORKER_LEASE_SECONDS', 60, issues);
  const heartbeatSeconds = readPositiveInt(source, 'WORKER_HEARTBEAT_SECONDS', 15, issues);
  const shutdownGraceSeconds = readPositiveInt(source, 'WORKER_SHUTDOWN_GRACE_SECONDS', 30, issues);
  if (heartbeatSeconds >= leaseSeconds) {
    issues.push({
      field: 'WORKER_HEARTBEAT_SECONDS',
      problem: 'must be shorter than WORKER_LEASE_SECONDS',
    });
  }

  const providerId = readString(source, 'WORKER_PROVIDER_ID');
  const providerLabel = readString(source, 'WORKER_PROVIDER_LABEL') ?? 'Managed provider';
  const providerBaseUrl = readString(source, 'WORKER_PROVIDER_BASE_URL');
  const providerApiKey = readString(source, 'WORKER_PROVIDER_API_KEY');
  const providerModels = parseModels(readString(source, 'WORKER_PROVIDER_MODELS'), issues);

  let provider: WorkerConfig['provider'];
  if (generationEnabled) {
    for (const [field, value] of [
      ['DATABASE_URL', databaseUrl],
      ['WORKER_PROVIDER_ID', providerId],
      ['WORKER_PROVIDER_BASE_URL', providerBaseUrl],
      ['WORKER_PROVIDER_API_KEY', providerApiKey],
      ['WORKER_PROVIDER_MODELS', providerModels.length === 0 ? undefined : 'configured'],
    ] as const) {
      if (value === undefined) {
        issues.push({ field, problem: 'required when WORKER_GENERATION_ENABLED=true' });
      }
    }
    if (providerBaseUrl !== undefined) validateProviderBaseUrl(providerBaseUrl, issues);
    if (providerId !== undefined && !/^[a-zA-Z0-9._-]{1,128}$/.test(providerId)) {
      issues.push({ field: 'WORKER_PROVIDER_ID', problem: 'contains unsupported characters' });
    }
    if (
      providerId !== undefined &&
      providerBaseUrl !== undefined &&
      providerApiKey !== undefined &&
      providerModels.length > 0
    ) {
      provider = {
        providerId,
        label: providerLabel,
        baseUrl: providerBaseUrl,
        apiKey: providerApiKey,
        models: providerModels,
      };
    }
  }

  const metricsPortRaw = readString(source, 'METRICS_PORT');
  const metricsPort =
    metricsPortRaw === undefined
      ? undefined
      : readPositiveInt(source, 'METRICS_PORT', 9090, issues);
  if (metricsPort !== undefined && metricsPort > 65535) {
    issues.push({ field: 'METRICS_PORT', problem: 'must be at most 65535' });
  }
  const cleanupIntervalSeconds = readPositiveInt(source, 'CLEANUP_INTERVAL_SECONDS', 300, issues);
  const retention = {
    uploadIncompleteHours: readPositiveInt(source, 'RETENTION_UPLOAD_INCOMPLETE_HOURS', 1, issues),
    inputMediaHours: readPositiveInt(source, 'RETENTION_INPUT_MEDIA_HOURS', 24, issues),
    resultMediaDays: readPositiveInt(source, 'RETENTION_RESULT_MEDIA_DAYS', 7, issues),
    generationDays: readPositiveInt(source, 'RETENTION_GENERATION_DAYS', 30, issues),
    auditEventDays: readPositiveInt(source, 'RETENTION_AUDIT_EVENT_DAYS', 90, issues),
  };

  if (issues.length > 0) throw new WorkerConfigError(issues);

  return {
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    mediaStorageRoot: readString(source, 'MEDIA_STORAGE_ROOT') ?? '/var/lib/onepic/media',
    cleanupIntervalSeconds,
    retention,
    metricsHost: readString(source, 'METRICS_HOST') ?? '127.0.0.1',
    ...(metricsPort === undefined ? {} : { metricsPort }),
    generationEnabled,
    generation: {
      concurrency,
      pollIntervalMs,
      leaseSeconds,
      heartbeatSeconds,
      shutdownGraceMs: shutdownGraceSeconds * 1000,
    },
    ...(provider === undefined ? {} : { provider }),
  };
}

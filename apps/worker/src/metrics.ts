import type { Queryable } from './queue.js';

/**
 * Low-cardinality metrics and alert evaluation (O02, architecture §9).
 *
 * Metrics are exposed in Prometheus text exposition format. Label cardinality
 * is deliberately bounded: the only label in use is job `kind` (a fixed enum
 * from the job table); counters are label-free. Gauges are derived from the
 * database at scrape time; counters accumulate in-process (sweep/purge/
 * storage failures) and reset on worker restart — both are honest signals.
 *
 * Alert evaluation is a pure threshold function so the same rules can be
 * unit-tested and later wired to any notifier; exceeding a threshold yields
 * an alert entry, never a silent log line.
 */

export interface MetricsRegistry {
  increment(name: string, by?: number): void;
  value(name: string): number;
  entries(): Array<[string, number]>;
}

export function createMetricsRegistry(): MetricsRegistry {
  const counters = new Map<string, number>();
  return {
    increment(name: string, by = 1): void {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },
    value(name: string): number {
      return counters.get(name) ?? 0;
    },
    entries(): Array<[string, number]> {
      return [...counters.entries()].sort(([a], [b]) => a.localeCompare(b));
    },
  };
}

/** Counter names (registered at worker startup so they render as 0 too). */
export const COUNTER_SWEEP_FAILURES = 'onepic_retention_sweep_failures_total';
export const COUNTER_PURGE_FAILURES = 'onepic_media_purge_failures_total';
export const COUNTER_STORAGE_FAILURES = 'onepic_storage_failures_total';

const COUNTER_HELP: Record<string, string> = {
  [COUNTER_SWEEP_FAILURES]: 'Retention sweeps that failed outright.',
  [COUNTER_PURGE_FAILURES]: 'Media objects whose physical purge failed (retried next sweep).',
  [COUNTER_STORAGE_FAILURES]: 'Storage remove operations that threw.',
};

export interface GaugeSample {
  name: string;
  help: string;
  value: number;
  labels?: Record<string, string>;
}

/** Scrapes DB-derived gauges. All queries are aggregate-only. */
export async function collectGauges(db: Queryable): Promise<GaugeSample[]> {
  const queueAge = (
    await db.query<{ kind: string; age_seconds: string }>(
      `SELECT kind, EXTRACT(EPOCH FROM now() - min(created_at)) AS age_seconds
       FROM job WHERE state = 'pending' GROUP BY kind ORDER BY kind`,
    )
  ).rows.map<GaugeSample>((row) => ({
    name: 'onepic_queue_oldest_pending_age_seconds',
    help: 'Age in seconds of the oldest pending job, per kind.',
    value: Number(row.age_seconds),
    labels: { kind: row.kind },
  }));

  const unknown = (
    await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM generation WHERE state = 'outcome_unknown'`,
    )
  ).rows[0];
  const pendingPurge = (
    await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM media_object WHERE state = 'expired'`,
    )
  ).rows[0];

  return [
    ...queueAge,
    {
      name: 'onepic_generations_outcome_unknown',
      help: 'Generations parked in outcome_unknown awaiting reconciliation.',
      value: Number(unknown?.n ?? '0'),
    },
    {
      name: 'onepic_media_pending_purge',
      help: 'Media objects in the deletion channel (expired, bytes not yet purged).',
      value: Number(pendingPurge?.n ?? '0'),
    },
  ];
}

/** Renders counters + gauges in Prometheus text exposition format. */
export function renderPrometheus(registry: MetricsRegistry, gauges: GaugeSample[]): string {
  const lines: string[] = [];
  for (const [name, value] of registry.entries()) {
    lines.push(`# HELP ${name} ${COUNTER_HELP[name] ?? 'Counter.'}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  }
  const seenTypes = new Set<string>();
  for (const gauge of gauges) {
    if (!seenTypes.has(gauge.name)) {
      seenTypes.add(gauge.name);
      lines.push(`# HELP ${gauge.name} ${gauge.help}`);
      lines.push(`# TYPE ${gauge.name} gauge`);
    }
    const labels =
      gauge.labels === undefined
        ? ''
        : `{${Object.entries(gauge.labels)
            .map(([key, value]) => `${key}="${value}"`)
            .join(',')}}`;
    lines.push(`${gauge.name}${labels} ${gauge.value}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface AlertThresholds {
  /** Oldest pending job older than this many seconds → QUEUE_STUCK. */
  queueOldestPendingAgeSeconds: number;
  /** More outcome_unknown generations than this → OUTCOME_UNKNOWN_PENDING. */
  outcomeUnknownCount: number;
  /** More expired-but-unpurged media than this → PURGE_BACKLOG. */
  mediaPendingPurgeCount: number;
  /** Any sweep failures since startup → SWEEP_FAILING. */
  retentionSweepFailures: number;
  /** Any storage failures since startup → STORAGE_FAILING. */
  storageFailures: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  queueOldestPendingAgeSeconds: 300,
  outcomeUnknownCount: 0,
  mediaPendingPurgeCount: 0,
  retentionSweepFailures: 0,
  storageFailures: 0,
};

export interface Alert {
  alert: string;
  metric: string;
  value: number;
  threshold: number;
}

/** Pure threshold evaluation over a scrape; empty result means no alert. */
export function evaluateAlerts(
  input: { gauges: GaugeSample[]; registry: MetricsRegistry },
  thresholds: AlertThresholds,
): Alert[] {
  const alerts: Alert[] = [];
  const gaugeValue = (name: string): number =>
    input.gauges.filter((g) => g.name === name).reduce((max, g) => Math.max(max, g.value), 0);
  const check = (alert: string, metric: string, value: number, threshold: number): void => {
    if (value > threshold) {
      alerts.push({ alert, metric, value, threshold });
    }
  };
  check(
    'QUEUE_STUCK',
    'onepic_queue_oldest_pending_age_seconds',
    gaugeValue('onepic_queue_oldest_pending_age_seconds'),
    thresholds.queueOldestPendingAgeSeconds,
  );
  check(
    'OUTCOME_UNKNOWN_PENDING',
    'onepic_generations_outcome_unknown',
    gaugeValue('onepic_generations_outcome_unknown'),
    thresholds.outcomeUnknownCount,
  );
  check(
    'PURGE_BACKLOG',
    'onepic_media_pending_purge',
    gaugeValue('onepic_media_pending_purge'),
    thresholds.mediaPendingPurgeCount,
  );
  check(
    'SWEEP_FAILING',
    COUNTER_SWEEP_FAILURES,
    input.registry.value(COUNTER_SWEEP_FAILURES),
    thresholds.retentionSweepFailures,
  );
  check(
    'STORAGE_FAILING',
    COUNTER_STORAGE_FAILURES,
    input.registry.value(COUNTER_STORAGE_FAILURES),
    thresholds.storageFailures,
  );
  return alerts;
}

/**
 * Internal metrics HTTP handler (node:http, no framework — the worker may not
 * depend on one, §4). Served on a loopback-only ops port, never through the
 * public API; that is why it is deliberately absent from the OpenAPI contract.
 */
export function createMetricsHandler(deps: {
  db: Queryable;
  registry: MetricsRegistry;
  thresholds?: AlertThresholds;
  isReady?: () => boolean;
}): (
  request: { url?: string },
  response: { writeHead(s: number, h: Record<string, string>): void; end(b?: string): void },
) => Promise<void> {
  const thresholds = deps.thresholds ?? DEFAULT_ALERT_THRESHOLDS;
  return async (request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (path === '/internal/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { status: 'ok' } }));
      return;
    }
    if (path === '/internal/health/ready') {
      try {
        await deps.db.query('SELECT 1');
        const ready = deps.isReady?.() ?? true;
        response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { status: ready ? 'ok' : 'stopping' } }));
      } catch {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: { status: 'degraded' } }));
      }
      return;
    }
    if (path !== '/metrics' && path !== '/internal/metrics') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
      return;
    }
    try {
      const gauges = await collectGauges(deps.db);
      const alerts = evaluateAlerts({ gauges, registry: deps.registry }, thresholds);
      const body = renderPrometheus(deps.registry, gauges);
      response.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        ...(alerts.length > 0 ? { 'x-onepic-alerts': alerts.map((a) => a.alert).join(',') } : {}),
      });
      response.end(body);
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'METRICS_UNAVAILABLE' } }));
    }
  };
}

import { afterEach, describe, expect, it, vi } from 'vitest';

import { logEvent } from './logging.js';
import {
  COUNTER_SWEEP_FAILURES,
  createMetricsRegistry,
  evaluateAlerts,
  renderPrometheus,
  DEFAULT_ALERT_THRESHOLDS,
} from './metrics.js';

const SENTINEL_KEY = 'sk-o02-unit-sentinel-abc123';
const SENTINEL_PROMPT = 'o02 unit canary prompt body';

describe('logEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints redacted structured JSON — sentinels never reach stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logEvent('retention_sweep_failed', {
      reason: `provider key ${SENTINEL_KEY} rejected`,
      prompt: SENTINEL_PROMPT,
      headers: { cookie: 'onepic_session=o02-unit-session' },
      url: `/api/v1/media/private/r.png?signature=o02-unit-signature&expires=1`,
      failures: 1,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect(line).not.toContain(SENTINEL_KEY);
    expect(line).not.toContain(SENTINEL_PROMPT);
    expect(line).not.toContain('o02-unit-session');
    expect(line).not.toContain('o02-unit-signature');
    // Low-cardinality signal survives.
    expect(JSON.parse(line)).toMatchObject({ event: 'retention_sweep_failed', failures: 1 });
  });
});

describe('metrics registry + rendering', () => {
  it('accumulates counters and renders Prometheus text with bounded labels', () => {
    const registry = createMetricsRegistry();
    registry.increment(COUNTER_SWEEP_FAILURES);
    registry.increment(COUNTER_SWEEP_FAILURES);
    const text = renderPrometheus(registry, [
      {
        name: 'onepic_queue_oldest_pending_age_seconds',
        help: 'Age.',
        value: 42.5,
        labels: { kind: 'generate' },
      },
      { name: 'onepic_generations_outcome_unknown', help: 'Unknown.', value: 2 },
    ]);
    expect(text).toContain('# TYPE onepic_retention_sweep_failures_total counter');
    expect(text).toContain('onepic_retention_sweep_failures_total 2');
    expect(text).toContain('onepic_queue_oldest_pending_age_seconds{kind="generate"} 42.5');
    expect(text).toContain('onepic_generations_outcome_unknown 2');
  });
});

describe('evaluateAlerts', () => {
  it('triggers QUEUE_STUCK when the oldest pending job exceeds the threshold', () => {
    const registry = createMetricsRegistry();
    const alerts = evaluateAlerts(
      {
        registry,
        gauges: [
          {
            name: 'onepic_queue_oldest_pending_age_seconds',
            help: '',
            value: 900,
            labels: { kind: 'generate' },
          },
        ],
      },
      DEFAULT_ALERT_THRESHOLDS,
    );
    expect(alerts).toEqual([
      {
        alert: 'QUEUE_STUCK',
        metric: 'onepic_queue_oldest_pending_age_seconds',
        value: 900,
        threshold: 300,
      },
    ]);
  });

  it('stays quiet at or below every threshold', () => {
    const registry = createMetricsRegistry();
    const alerts = evaluateAlerts(
      {
        registry,
        gauges: [
          { name: 'onepic_queue_oldest_pending_age_seconds', help: '', value: 300 },
          { name: 'onepic_generations_outcome_unknown', help: '', value: 0 },
          { name: 'onepic_media_pending_purge', help: '', value: 0 },
        ],
      },
      DEFAULT_ALERT_THRESHOLDS,
    );
    expect(alerts).toEqual([]);
  });

  it('fires sweep/storage failure alerts on any nonzero counter', () => {
    const registry = createMetricsRegistry();
    registry.increment(COUNTER_SWEEP_FAILURES);
    const alerts = evaluateAlerts({ registry, gauges: [] }, DEFAULT_ALERT_THRESHOLDS);
    expect(alerts.map((a) => a.alert)).toContain('SWEEP_FAILING');
  });
});

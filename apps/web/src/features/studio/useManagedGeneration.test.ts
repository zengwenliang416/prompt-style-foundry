// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

import { createOnePicClient } from '@onepic/client';

import {
  MANAGED_INFLIGHT_KEY,
  readInflight,
  useManagedGeneration,
} from './useManagedGeneration.js';
import { BYOK_KEY_STORAGE } from '../../entities/settings/store.js';

/**
 * W01 web-side acceptance: the managed flow state machine (upload →
 * precheck → submit → poll → download), localStorage refresh recovery,
 * single-submit idempotency under repeated clicks, and the guarantee that
 * the browser BYOK key never enters a managed request. The API is scripted
 * through the client's fetch seam; the flow itself is the real composable.
 */

const TEMPLATE_SHA = 'a'.repeat(64);

interface ScriptStep {
  status: number;
  body: unknown;
}

interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyText: string | null;
}

function scriptApi(steps: Record<string, ScriptStep[]>): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      const key = `${method} ${path}`;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(init?.headers ?? {})) {
        headers[name] = String(value);
      }
      const bodyText =
        init?.body === undefined || init.body === null
          ? null
          : typeof init.body === 'string'
            ? init.body
            : `binary:${(init.body as ArrayBuffer).byteLength}`;
      calls.push({ method, path, headers, bodyText });
      const queue = steps[key];
      // Repeat the last scripted step once the queue drains (long polls);
      // status 0 simulates a network drop (fetch TypeError).
      const step =
        queue !== undefined && queue.length > 0
          ? queue.length > 1
            ? queue.shift()!
            : queue[0]!
          : {
              status: 404,
              body: { error: { code: 'NOT_FOUND', message: 'not found', correlationId: 'c' } },
            };
      if (step.status === 0) {
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify(step.body), {
        status: step.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

function makeFile(): File {
  return new File([PNG_BYTES], 'input.png', { type: 'image/png' });
}

function successScript(generationId: string): Record<string, ScriptStep[]> {
  return {
    'POST /api/v1/uploads': [
      {
        status: 201,
        body: {
          data: { uploadId: 'up-1', bucket: 'quarantine', expiresAt: '2026-09-06T00:00:00Z' },
        },
      },
    ],
    'PUT /api/v1/uploads/up-1/bytes': [{ status: 200, body: { data: { bytes: 4 } } }],
    'POST /api/v1/uploads/up-1/confirm': [
      { status: 200, body: { data: { mediaObjectId: 'mo-1', bytes: 4 } } },
    ],
    'POST /api/v1/prechecks': [
      { status: 201, body: { data: { precheckId: 'pc-1', expiresAt: '2026-09-06T00:00:00Z' } } },
    ],
    'POST /api/v1/generations': [
      {
        status: 202,
        body: {
          data: {
            id: generationId,
            state: 'queued',
            templateId: 'case-101',
            templateVersion: 1,
            createdAt: '2026-09-06T00:00:00Z',
          },
          meta: { pollAfterMs: 5 },
        },
      },
    ],
    [`GET /api/v1/generations/${generationId}`]: [
      {
        status: 200,
        body: {
          data: {
            id: generationId,
            state: 'running',
            templateId: 'case-101',
            templateVersion: 1,
            createdAt: '2026-09-06T00:00:00Z',
          },
          meta: { pollAfterMs: 5 },
        },
      },
      {
        status: 200,
        body: {
          data: {
            id: generationId,
            state: 'succeeded',
            templateId: 'case-101',
            templateVersion: 1,
            createdAt: '2026-09-06T00:00:00Z',
            completedAt: '2026-09-06T00:01:00Z',
            result: {
              objectId: 'ro-1',
              actualMime: 'image/png',
              actualBytes: 99,
              actualWidth: 3,
              actualHeight: 2,
              sha256: 'b'.repeat(64),
            },
          },
          meta: {
            pollAfterMs: 5,
            downloadUrl: '/api/v1/media/private/results/x.png?owner=s&expires=1&signature=sig',
            downloadExpires: 1,
          },
        },
      },
    ],
  };
}

function makeClient() {
  return createOnePicClient({ baseUrl: 'http://localhost' });
}

describe('useManagedGeneration (W01)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('crypto', webcrypto);
    localStorage.clear();
  });

  it('runs upload → precheck → submit → poll → download in order', async () => {
    const { calls } = scriptApi(successScript('gen-1'));
    const managed = useManagedGeneration({ client: makeClient() });

    await managed.start({ file: makeFile(), templateId: 'case-101', promptSha256: TEMPLATE_SHA });

    expect(managed.phase.value).toBe('succeeded');
    expect(managed.result.value).toMatchObject({
      generationId: 'gen-1',
      actualWidth: 3,
      actualHeight: 2,
      sha256: 'b'.repeat(64),
    });
    expect(managed.result.value?.downloadUrl).toContain('/api/v1/media/private/');

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/uploads',
      'PUT /api/v1/uploads/up-1/bytes',
      'POST /api/v1/uploads/up-1/confirm',
      'POST /api/v1/prechecks',
      'POST /api/v1/generations',
      'GET /api/v1/generations/gen-1',
      'GET /api/v1/generations/gen-1',
    ]);

    // Single-image protocol: no aspect/text fields ever leave the browser.
    const precheckBody = JSON.parse(calls[3]!.bodyText ?? '{}');
    expect(precheckBody.settings).toEqual({ model: 'gpt-image-2', quality: 'high' });
    const generationBody = JSON.parse(calls[4]!.bodyText ?? '{}');
    expect(generationBody.settings).not.toHaveProperty('aspectRatio');
    expect(generationBody.promptSha256).toBe(TEMPLATE_SHA);

    // The inflight record was written during flight and cleared on success.
    expect(readInflight()).toBeNull();
  });

  it('persists the in-flight id so a refreshed page can resume polling', async () => {
    const { calls } = scriptApi(successScript('gen-2'));
    let observedDuringFlight: string | null | undefined;
    const first = useManagedGeneration({
      client: makeClient(),
      // Deterministic checkpoint: the first poll wait runs after submit, so
      // the record must already be on disk at that moment.
      wait: async () => {
        if (observedDuringFlight === undefined) {
          observedDuringFlight = readInflight()?.generationId;
        }
      },
    });
    await first.start({ file: makeFile(), templateId: 'case-101', promptSha256: TEMPLATE_SHA });

    expect(observedDuringFlight).toBe('gen-2');
    expect(calls.some((c) => c.path === '/api/v1/generations/gen-2')).toBe(true);
  });

  it('resumes polling from the persisted record on remount and clears it at a terminal state', async () => {
    localStorage.setItem(
      MANAGED_INFLIGHT_KEY,
      JSON.stringify({
        schemaVersion: 1,
        generationId: 'gen-3',
        templateId: 'case-101',
        startedAt: '2026-09-06T00:00:00Z',
      }),
    );
    const { calls } = scriptApi({
      'GET /api/v1/generations/gen-3': [
        {
          status: 200,
          body: {
            data: {
              id: 'gen-3',
              state: 'running',
              templateId: 'case-101',
              templateVersion: 1,
              createdAt: '2026-09-06T00:00:00Z',
            },
            meta: { pollAfterMs: 5 },
          },
        },
        {
          status: 200,
          body: {
            data: {
              id: 'gen-3',
              state: 'succeeded',
              templateId: 'case-101',
              templateVersion: 1,
              createdAt: '2026-09-06T00:00:00Z',
              result: {
                objectId: 'ro-3',
                actualMime: 'image/png',
                actualBytes: 1,
                actualWidth: 1,
                actualHeight: 1,
                sha256: 'c'.repeat(64),
              },
            },
            meta: {
              pollAfterMs: 5,
              downloadUrl: '/api/v1/media/private/r.png?owner=s&expires=1&signature=s',
            },
          },
        },
      ],
    });
    const managed = useManagedGeneration({ client: makeClient() });
    await managed.restore('case-101');

    expect(managed.phase.value).toBe('succeeded');
    expect(managed.result.value?.generationId).toBe('gen-3');
    expect(readInflight()).toBeNull();
    // No upload/submit happened — recovery only polls.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('clears the persisted record when the task is forbidden, gone, or the session is lost', async () => {
    for (const status of [401, 403, 404] as const) {
      localStorage.setItem(
        MANAGED_INFLIGHT_KEY,
        JSON.stringify({
          schemaVersion: 1,
          generationId: 'gen-x',
          templateId: 'case-101',
          startedAt: '',
        }),
      );
      scriptApi({
        'GET /api/v1/generations/gen-x': [
          {
            status,
            body: {
              error: {
                code:
                  status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'NOT_FOUND',
                message: 'denied',
                correlationId: 'c',
              },
            },
          },
        ],
      });
      const managed = useManagedGeneration({ client: makeClient() });
      await managed.restore('case-101');
      expect(readInflight()).toBeNull();
      expect(managed.phase.value).toBe('failed');
      vi.unstubAllGlobals();
    }
  });

  it('ignores a second click while an attempt is in flight (single submit)', async () => {
    const { calls } = scriptApi(successScript('gen-4'));
    const managed = useManagedGeneration({ client: makeClient() });

    const first = managed.start({
      file: makeFile(),
      templateId: 'case-101',
      promptSha256: TEMPLATE_SHA,
    });
    // Synchronous re-entry before the first attempt settles.
    const second = managed.start({
      file: makeFile(),
      templateId: 'case-101',
      promptSha256: TEMPLATE_SHA,
    });
    await Promise.all([first, second]);

    expect(calls.filter((c) => c.path === '/api/v1/generations')).toHaveLength(1);
    expect(managed.phase.value).toBe('succeeded');
  });

  it('never sends the browser BYOK key in any managed request', async () => {
    localStorage.setItem(BYOK_KEY_STORAGE, JSON.stringify('sk-browser-secret'));
    const { calls } = scriptApi(successScript('gen-5'));
    const managed = useManagedGeneration({ client: makeClient() });

    await managed.start({ file: makeFile(), templateId: 'case-101', promptSha256: TEMPLATE_SHA });

    expect(managed.phase.value).toBe('succeeded');
    for (const call of calls) {
      expect(call.bodyText ?? '').not.toContain('sk-browser-secret');
      expect(JSON.stringify(call.headers)).not.toContain('sk-browser-secret');
      expect(JSON.stringify(call.headers)).not.toContain('authorization');
    }
  });

  it('surfaces a login hint on UNAUTHENTICATED during submit', async () => {
    scriptApi({
      'POST /api/v1/uploads': [
        {
          status: 401,
          body: {
            error: { code: 'UNAUTHENTICATED', message: 'No active session', correlationId: 'c' },
          },
        },
      ],
    });
    const managed = useManagedGeneration({ client: makeClient() });
    await managed.start({ file: makeFile(), templateId: 'case-101', promptSha256: TEMPLATE_SHA });
    expect(managed.phase.value).toBe('failed');
    expect(managed.error.value).toContain('登录');
  });
});

describe('useManagedGeneration failure/cancel/expiry semantics (W02)', () => {
  function statusStep(
    generationId: string,
    state: string,
    dataExtra: Record<string, unknown> = {},
    metaExtra: Record<string, unknown> = {},
  ): ScriptStep {
    return {
      status: 200,
      body: {
        data: {
          id: generationId,
          state,
          templateId: 'case-101',
          templateVersion: 1,
          createdAt: '2026-09-06T00:00:00Z',
          ...dataExtra,
        },
        meta: { pollAfterMs: 5, ...metaExtra },
      },
    };
  }

  const SUCCEEDED_EXTRA: Record<string, unknown> = {
    completedAt: '2026-09-06T00:01:00Z',
    result: {
      objectId: 'ro-1',
      actualMime: 'image/png',
      actualBytes: 9,
      actualWidth: 3,
      actualHeight: 2,
      sha256: 'e'.repeat(64),
    },
  };
  const SUCCEEDED_META: Record<string, unknown> = {
    downloadUrl: '/api/v1/media/private/r.png?owner=s&expires=1&signature=s',
  };

  function errStep(status: number, code: string): ScriptStep {
    return { status, body: { error: { code, message: code, correlationId: 'c' } } };
  }

  /** Submit/confirm/precheck steps shared by the W02 cases. */
  function preSteps(generationId: string, pollSteps: ScriptStep[]): Record<string, ScriptStep[]> {
    return {
      'POST /api/v1/uploads': [
        {
          status: 201,
          body: {
            data: { uploadId: 'up-w2', bucket: 'quarantine', expiresAt: '2026-09-06T00:00:00Z' },
          },
        },
      ],
      'PUT /api/v1/uploads/up-w2/bytes': [{ status: 200, body: { data: { bytes: 4 } } }],
      'POST /api/v1/uploads/up-w2/confirm': [
        { status: 200, body: { data: { mediaObjectId: 'mo-w2', bytes: 4 } } },
      ],
      'POST /api/v1/prechecks': [
        { status: 201, body: { data: { precheckId: 'pc-w2', expiresAt: '2026-09-06T00:00:00Z' } } },
      ],
      'POST /api/v1/generations': [
        {
          status: 202,
          body: {
            data: {
              id: generationId,
              state: 'queued',
              templateId: 'case-101',
              templateVersion: 1,
              createdAt: '2026-09-06T00:00:00Z',
            },
            meta: { pollAfterMs: 5 },
          },
        },
      ],
      [`GET /api/v1/generations/${generationId}`]: pollSteps,
    };
  }

  function flowScript(generationId: string, pollSteps: ScriptStep[]): Record<string, ScriptStep[]> {
    return preSteps(generationId, pollSteps);
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('crypto', webcrypto);
    localStorage.clear();
  });

  it('backs off on 429 and keeps polling — never a task failure, never a resubmit', async () => {
    const waits: number[] = [];
    const notices: Array<string | null> = [];
    const { calls } = scriptApi(
      flowScript('gen-w02-1', [
        errStep(429, 'RATE_LIMITED'),
        errStep(429, 'RATE_LIMITED'),
        statusStep('gen-w02-1', 'succeeded', SUCCEEDED_EXTRA, SUCCEEDED_META),
      ]),
    );
    const managed = useManagedGeneration({
      client: makeClient(),
      wait: async (ms) => {
        waits.push(ms);
        notices.push(managedNoticePeek());
      },
    });
    function managedNoticePeek(): string | null {
      return managed.notice.value;
    }

    await managed.start({ file: makeFile(), templateId: 'case-101', promptSha256: TEMPLATE_SHA });

    expect(managed.phase.value).toBe('succeeded');
    // Bounded backoff: 2000ms then 4000ms (pollAfterMs=5 normal waits only
    // happen after successful polls — none here before success).
    expect(waits).toEqual([2000, 4000]);
    // A visible notice appeared while backing off.
    expect(notices.some((n) => n !== null && n.includes('暂时无法查询'))).toBe(true);
    // No implicit resubmission.
    expect(
      calls.filter((c) => c.path === '/api/v1/generations' && c.method === 'POST'),
    ).toHaveLength(1);
  });

  it('keeps polling through 5xx and network drops with a visible notice', async () => {
    const { calls } = scriptApi(
      flowScript('gen-w02-2', [
        errStep(500, 'INTERNAL'),
        { status: 0, body: null },
        statusStep('gen-w02-2', 'running'),
        statusStep('gen-w02-2', 'succeeded', SUCCEEDED_EXTRA, SUCCEEDED_META),
      ]),
    );
    const notices: Array<string | null> = [];
    const managed = useManagedGeneration({
      client: makeClient(),
      wait: async () => {
        notices.push(managed.notice.value);
      },
    });
    await managed.start({ file: makeFile(), templateId: 'case-101', promptSha256: TEMPLATE_SHA });

    expect(managed.phase.value).toBe('succeeded');
    expect(notices.some((n) => n !== null && n.includes('暂时无法查询'))).toBe(true);
    expect(calls.filter((c) => c.path === '/api/v1/generations/gen-w02-2')).toHaveLength(4);
  });

  it('shows an honest network error when the upload itself cannot leave the browser', async () => {
    const { calls } = scriptApi({ 'POST /api/v1/uploads': [{ status: 0, body: null }] });
    const managed = useManagedGeneration({ client: makeClient(), wait: async () => {} });
    await managed.start({ file: makeFile(), templateId: 'case-101', promptSha256: TEMPLATE_SHA });
    expect(managed.phase.value).toBe('failed');
    expect(managed.error.value).toContain('网络异常');
    expect(calls.filter((c) => c.path === '/api/v1/generations')).toHaveLength(0);
  });

  it('clears the inflight record and points at login when the session dies mid-poll', async () => {
    scriptApi(
      flowScript('gen-w02-3', [
        statusStep('gen-w02-3', 'running'),
        errStep(401, 'UNAUTHENTICATED'),
      ]),
    );
    const managed = useManagedGeneration({ client: makeClient(), wait: async () => {} });
    await managed.start({ file: makeFile(), templateId: 'case-101', promptSha256: TEMPLATE_SHA });
    expect(managed.phase.value).toBe('failed');
    expect(managed.error.value).toContain('登录');
    expect(readInflight()).toBeNull();
  });

  it('cancel of a queued task: terminal cancelled, record cleared, polling stops', async () => {
    const { calls } = scriptApi({
      ...flowScript('gen-w02-4', [statusStep('gen-w02-4', 'running')]),
      'POST /api/v1/generations/gen-w02-4/cancel': [
        {
          status: 200,
          body: { data: { id: 'gen-w02-4', state: 'cancelled', outcome: 'cancelled' } },
        },
      ],
    });
    const managed = useManagedGeneration({
      client: makeClient(),
      wait: () => new Promise((resolve) => setTimeout(resolve, 2)),
    });
    const started = managed.start({
      file: makeFile(),
      templateId: 'case-101',
      promptSha256: TEMPLATE_SHA,
    });
    await vi.waitFor(() => {
      expect(managed.phase.value).toBe('polling');
    });

    await managed.cancel();
    expect(managed.phase.value).toBe('cancelled');
    expect(readInflight()).toBeNull();

    // Polling stopped: no further status requests after the cancel.
    await started;
    const pollsAfter = calls.filter(
      (c) => c.path === '/api/v1/generations/gen-w02-4' && c.method === 'GET',
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      calls.filter((c) => c.path === '/api/v1/generations/gen-w02-4' && c.method === 'GET').length,
    ).toBe(pollsAfter);
  });

  it('cancel_requested keeps polling honestly until the real terminal state arrives', async () => {
    const pollSteps: ScriptStep[] = [statusStep('gen-w02-5', 'running')];
    scriptApi({
      ...flowScript('gen-w02-5', pollSteps),
      'POST /api/v1/generations/gen-w02-5/cancel': [
        {
          status: 200,
          body: {
            data: {
              id: 'gen-w02-5',
              state: 'running',
              outcome: 'cancel_requested',
              code: 'CANCEL_NOT_GUARANTEED',
            },
          },
        },
      ],
    });
    const managed = useManagedGeneration({
      client: makeClient(),
      wait: () => new Promise((resolve) => setTimeout(resolve, 2)),
    });
    const started = managed.start({
      file: makeFile(),
      templateId: 'case-101',
      promptSha256: TEMPLATE_SHA,
    });
    await vi.waitFor(() => {
      expect(managed.phase.value).toBe('polling');
    });

    await managed.cancel();
    // Honest, non-terminal: the notice says billing is not guaranteed and the
    // task is still being polled.
    expect(managed.notice.value).toContain('不保证免计费');
    expect(managed.phase.value).toBe('polling');

    // The real terminal state arrives via a later poll.
    pollSteps.push(statusStep('gen-w02-5', 'cancelled'));
    await started;
    expect(managed.phase.value).toBe('cancelled');
    expect(readInflight()).toBeNull();
  });

  it('out-of-order guard: a terminal state from cancel is never overwritten by a late stale poll', async () => {
    // Polls keep reporting the stale 'running'; another actor (second tab /
    // operator) cancelled the task, so the cancel call reports the terminal.
    const { calls } = scriptApi({
      ...flowScript('gen-w02-6', [statusStep('gen-w02-6', 'running')]),
      'POST /api/v1/generations/gen-w02-6/cancel': [
        {
          status: 200,
          body: { data: { id: 'gen-w02-6', state: 'cancelled', outcome: 'already_terminal' } },
        },
      ],
    });
    const managed = useManagedGeneration({
      client: makeClient(),
      wait: () => new Promise((resolve) => setTimeout(resolve, 2)),
    });
    const started = managed.start({
      file: makeFile(),
      templateId: 'case-101',
      promptSha256: TEMPLATE_SHA,
    });
    await vi.waitFor(() => {
      expect(managed.phase.value).toBe('polling');
    });

    await managed.cancel();
    expect(managed.phase.value).toBe('cancelled');
    await started;
    // Let late poll iterations arrive; the terminal state must hold.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(managed.phase.value).toBe('cancelled');
    expect(calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(1);
  });

  it('outcome_unknown: honest state, record KEPT for refresh, zero implicit resubmission, explicit dismiss only', async () => {
    const { calls } = scriptApi(
      flowScript('gen-w02-7', [
        statusStep('gen-w02-7', 'outcome_unknown', { errorCode: 'PROVIDER_TIMEOUT_UNKNOWN' }),
      ]),
    );
    const managed = useManagedGeneration({ client: makeClient(), wait: async () => {} });
    await managed.start({ file: makeFile(), templateId: 'case-101', promptSha256: TEMPLATE_SHA });

    expect(managed.phase.value).toBe('unknown');
    expect(managed.error.value).toContain('结果未知');
    // The record stays so a refresh lands back on this task.
    expect(readInflight()?.generationId).toBe('gen-w02-7');
    // Absolutely no second submission.
    expect(
      calls.filter((c) => c.path === '/api/v1/generations' && c.method === 'POST'),
    ).toHaveLength(1);

    managed.dismissUnknown();
    expect(managed.phase.value).toBe('idle');
    expect(readInflight()).toBeNull();
  });

  it('a refreshed page lands back on the same outcome_unknown task', async () => {
    localStorage.setItem(
      MANAGED_INFLIGHT_KEY,
      JSON.stringify({
        schemaVersion: 2,
        templateId: 'case-101',
        startedAt: '',
        generationId: 'gen-w02-8',
      }),
    );
    scriptApi({
      'GET /api/v1/generations/gen-w02-8': [
        statusStep('gen-w02-8', 'outcome_unknown', { errorCode: 'PROVIDER_TIMEOUT_UNKNOWN' }),
      ],
    });
    const managed = useManagedGeneration({ client: makeClient(), wait: async () => {} });
    await managed.restore('case-101');
    expect(managed.phase.value).toBe('unknown');
    expect(readInflight()?.generationId).toBe('gen-w02-8');
  });

  it('expired: history stays queryable, download gone, record cleared', async () => {
    scriptApi(flowScript('gen-w02-9', [statusStep('gen-w02-9', 'expired')]));
    const managed = useManagedGeneration({ client: makeClient(), wait: async () => {} });
    await managed.start({ file: makeFile(), templateId: 'case-101', promptSha256: TEMPLATE_SHA });
    expect(managed.phase.value).toBe('expired');
    expect(managed.notice.value).toContain('已过期');
    expect(readInflight()).toBeNull();
  });

  it('replays an unconfirmed submit with the SAME idempotency key after a refresh', async () => {
    const body = {
      templateId: 'case-101',
      templateVersion: 1,
      promptSha256: TEMPLATE_SHA,
      sourceObjectId: 'mo-w2',
      precheckId: 'pc-w2',
      settings: { model: 'gpt-image-2', quality: 'high' },
    };
    localStorage.setItem(
      MANAGED_INFLIGHT_KEY,
      JSON.stringify({
        schemaVersion: 2,
        templateId: 'case-101',
        startedAt: '',
        submit: { idempotencyKey: 'idem-replay-0001', body },
      }),
    );
    const { calls } = scriptApi({
      'POST /api/v1/generations': [
        {
          status: 202,
          body: {
            data: {
              id: 'gen-w02-10',
              state: 'queued',
              templateId: 'case-101',
              templateVersion: 1,
              createdAt: '2026-09-06T00:00:00Z',
            },
            meta: { pollAfterMs: 5 },
          },
        },
      ],
      'GET /api/v1/generations/gen-w02-10': [
        statusStep('gen-w02-10', 'succeeded', SUCCEEDED_EXTRA, SUCCEEDED_META),
      ],
    });
    const managed = useManagedGeneration({ client: makeClient(), wait: async () => {} });
    await managed.restore('case-101');

    expect(managed.phase.value).toBe('succeeded');
    const submits = calls.filter((c) => c.path === '/api/v1/generations' && c.method === 'POST');
    expect(submits).toHaveLength(1);
    expect(submits[0]!.headers['idempotency-key']).toBe('idem-replay-0001');
    // Recovery replays the submission — it must NOT re-upload or re-precheck.
    expect(calls.some((c) => c.path === '/api/v1/uploads')).toBe(false);
    expect(calls.some((c) => c.path === '/api/v1/prechecks')).toBe(false);
  });
});

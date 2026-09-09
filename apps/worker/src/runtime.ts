import type { Pool, PoolClient } from 'pg';

import { executeClaimedJob, type ExecutionDeps } from './execute.js';
import { claimJobs, completeJob, failJob, heartbeat } from './queue.js';
import { deadLetterJob, markGenerationOutcomeUnknown } from './reconcile.js';

export interface GenerationWorkerOptions {
  pool: Pool;
  execution: Omit<ExecutionDeps, 'db' | 'abortSignal' | 'onProviderRequestStarted'>;
  concurrency: number;
  pollIntervalMs: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  shutdownGraceMs: number;
  workerIdPrefix?: string;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

interface ActiveJob {
  jobId: string;
  generationId: string;
  workerId: string;
  abortController: AbortController;
  providerStarted: boolean;
  attemptId?: string;
}

export interface GenerationWorkerSnapshot {
  started: boolean;
  stopping: boolean;
  activeJobs: number;
  concurrency: number;
}

export interface GenerationWorkerStopReport {
  graceful: boolean;
  activeAtSignal: number;
  markedOutcomeUnknown: number;
  aborted: number;
  remaining: number;
}

/**
 * Deployable PG-backed generation consumer (O05).
 *
 * Each slot owns one PoolClient so queue transactions never cross connections.
 * SIGTERM/SIGINT stops new claims and waits for in-flight work. If the grace
 * window expires after a provider request may have started, the task is parked
 * in outcome_unknown and dead-lettered before the request is aborted. The job
 * is therefore never returned to pending for a blind paid re-send.
 */
export class GenerationWorkerRuntime {
  private readonly options: GenerationWorkerOptions;
  private readonly active = new Map<string, ActiveJob>();
  private readonly wakeWaiters = new Set<() => void>();
  private workers: Promise<void>[] = [];
  private started = false;
  private stopping = false;

  constructor(options: GenerationWorkerOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
      throw new Error('worker concurrency must be a positive integer');
    }
    if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
      throw new Error('worker poll interval must be a positive integer');
    }
    if (!Number.isInteger(options.leaseSeconds) || options.leaseSeconds <= 0) {
      throw new Error('worker lease must be a positive integer');
    }
    if (
      !Number.isInteger(options.heartbeatSeconds) ||
      options.heartbeatSeconds <= 0 ||
      options.heartbeatSeconds >= options.leaseSeconds
    ) {
      throw new Error('worker heartbeat must be positive and shorter than the lease');
    }
    if (!Number.isInteger(options.shutdownGraceMs) || options.shutdownGraceMs <= 0) {
      throw new Error('worker shutdown grace must be a positive integer');
    }
    this.options = options;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const prefix = this.options.workerIdPrefix ?? `worker-${process.pid}`;
    this.workers = Array.from({ length: this.options.concurrency }, (_, index) =>
      this.runSlot(`${prefix}-${index + 1}`),
    );
    this.log('generation_worker_started', { concurrency: this.options.concurrency });
  }

  snapshot(): GenerationWorkerSnapshot {
    return {
      started: this.started,
      stopping: this.stopping,
      activeJobs: this.active.size,
      concurrency: this.options.concurrency,
    };
  }

  async stop(): Promise<GenerationWorkerStopReport> {
    if (!this.started) {
      return {
        graceful: true,
        activeAtSignal: 0,
        markedOutcomeUnknown: 0,
        aborted: 0,
        remaining: 0,
      };
    }
    if (this.stopping) {
      await Promise.allSettled(this.workers);
      return {
        graceful: this.active.size === 0,
        activeAtSignal: this.active.size,
        markedOutcomeUnknown: 0,
        aborted: 0,
        remaining: this.active.size,
      };
    }

    this.stopping = true;
    const activeAtSignal = this.active.size;
    this.wakeAll();
    const graceful = await settlesWithin(this.workers, this.options.shutdownGraceMs);
    if (graceful) {
      this.log('generation_worker_stopped', { graceful: true, activeAtSignal });
      return {
        graceful: true,
        activeAtSignal,
        markedOutcomeUnknown: 0,
        aborted: 0,
        remaining: 0,
      };
    }

    let markedOutcomeUnknown = 0;
    let aborted = 0;
    const jobs = [...this.active.values()];
    for (const active of jobs) {
      if (active.providerStarted) {
        const marked = await markGenerationOutcomeUnknown(this.options.pool, {
          generationId: active.generationId,
          ...(active.attemptId === undefined ? {} : { attemptId: active.attemptId }),
        });
        const dead = await deadLetterJob(this.options.pool, {
          jobId: active.jobId,
          workerId: active.workerId,
          reason: 'WORKER_SHUTDOWN_OUTCOME_UNKNOWN',
        });
        if (marked || dead) markedOutcomeUnknown += 1;
      }
      if (!active.abortController.signal.aborted) {
        active.abortController.abort(new Error('worker shutdown grace elapsed'));
        aborted += 1;
      }
    }

    await settlesWithin(this.workers, Math.min(5_000, this.options.shutdownGraceMs));
    const remaining = this.active.size;
    this.log('generation_worker_stopped', {
      graceful: false,
      activeAtSignal,
      markedOutcomeUnknown,
      aborted,
      remaining,
    });
    return { graceful: false, activeAtSignal, markedOutcomeUnknown, aborted, remaining };
  }

  private async runSlot(workerId: string): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await this.options.pool.connect();
      while (!this.stopping) {
        const [job] = await claimJobs(client, {
          workerId,
          leaseSeconds: this.options.leaseSeconds,
          batch: 1,
          kinds: ['generate'],
        });
        if (job === undefined) {
          await this.waitForWork();
          continue;
        }
        await this.runJob(client, workerId, job);
      }
    } catch (error) {
      this.log('generation_worker_slot_failed', {
        workerId,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      client?.release();
    }
    if (!this.stopping) {
      await this.waitForWork();
      return this.runSlot(workerId);
    }
  }

  private async runJob(
    client: PoolClient,
    workerId: string,
    job: { jobId: string; generationId: string },
  ): Promise<void> {
    const abortController = new AbortController();
    const active: ActiveJob = {
      workerId,
      jobId: job.jobId,
      generationId: job.generationId,
      abortController,
      providerStarted: false,
    };
    this.active.set(job.jobId, active);
    const heartbeatTimer = setInterval(() => {
      void heartbeat(this.options.pool, {
        jobId: job.jobId,
        workerId,
        leaseSeconds: this.options.leaseSeconds,
      })
        .then((owned) => {
          if (!owned && !abortController.signal.aborted) {
            abortController.abort(new Error('worker lease lost'));
          }
        })
        .catch((error: unknown) => {
          this.log('generation_worker_heartbeat_failed', {
            workerId,
            jobId: job.jobId,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
    }, this.options.heartbeatSeconds * 1000);
    heartbeatTimer.unref?.();

    try {
      const outcome = await executeClaimedJob(
        {
          ...this.options.execution,
          db: client,
          abortSignal: abortController.signal,
          onProviderRequestStarted: ({ attemptId }) => {
            active.providerStarted = true;
            active.attemptId = attemptId;
          },
        },
        { jobId: job.jobId, generationId: job.generationId, workerId },
      );
      if (outcome.ok) {
        const completion = await completeJob(client, {
          jobId: job.jobId,
          generationId: job.generationId,
          workerId,
          generationState: 'succeeded',
        });
        if (!completion.completed) {
          this.log('generation_worker_completion_rejected', {
            workerId,
            jobId: job.jobId,
            reason: completion.reason,
          });
        }
      }
    } catch (error) {
      if (active.providerStarted) {
        await markGenerationOutcomeUnknown(client, {
          generationId: job.generationId,
          ...(active.attemptId === undefined ? {} : { attemptId: active.attemptId }),
        });
        await deadLetterJob(client, {
          jobId: job.jobId,
          workerId,
          reason: 'WORKER_EXECUTION_INTERRUPTED',
        });
      } else {
        await failJob(client, {
          jobId: job.jobId,
          generationId: job.generationId,
          workerId,
          reason: 'INTERNAL',
          retryable: true,
          retryDelaySeconds: 5,
        });
      }
      this.log('generation_worker_job_failed', {
        workerId,
        jobId: job.jobId,
        providerStarted: active.providerStarted,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearInterval(heartbeatTimer);
      this.active.delete(job.jobId);
    }
  }

  private async waitForWork(): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeWaiters.delete(wake);
        resolve();
      }, this.options.pollIntervalMs);
      const wake = (): void => {
        clearTimeout(timer);
        this.wakeWaiters.delete(wake);
        resolve();
      };
      this.wakeWaiters.add(wake);
    });
  }

  private wakeAll(): void {
    for (const wake of [...this.wakeWaiters]) wake();
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.options.log?.(event, fields);
  }
}

async function settlesWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  if (promises.length === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const settled = Promise.allSettled(promises).then(() => true);
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-memory fake image-generation provider (checklist F04).
 *
 * The real allowlisted provider adapters and their contract tests arrive
 * with J04/J05; this double records exactly what a caller sends (including
 * the Authorization header, for leak/tracing assertions) and replies with
 * scripted responses, so unit/integration tests can exercise success,
 * provider errors, and timeouts without any network egress or paid call.
 */

export interface RecordedProviderRequest {
  method: string;
  path: string;
  /** Full header set as received; safe to inspect in-process. */
  headers: Record<string, string | string[] | undefined>;
  /** Raw request body bytes, for byte-level tracing assertions (J05). */
  body: Buffer;
}

export interface MockProviderHandle {
  /** e.g. http://127.0.0.1:54321 — point an adapter's baseUrl here. */
  baseUrl: string;
  port: number;
  readonly requests: readonly RecordedProviderRequest[];
  /** Queue responses; the last one repeats once the queue is drained. */
  scriptResponses(responses: Array<{ status: number; body: string; headers?: Record<string, string> }>): void;
  /** Delay every response by the given milliseconds (timeout tests). */
  setDelayMs(delayMs: number): void;
  close(): Promise<void>;
}

const DEFAULT_SUCCESS_BODY = JSON.stringify({
  data: [
    {
      b64_json: Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
        'hex',
      ).toString('base64'),
    },
  ],
});

export function startMockProvider(): Promise<MockProviderHandle> {
  const requests: RecordedProviderRequest[] = [];
  let scripted: Array<{ status: number; body: string; headers?: Record<string, string> }> = [];
  let delayMs = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });

      const respond = (): void => {
        const next = scripted.shift() ?? { status: 200, body: DEFAULT_SUCCESS_BODY };
        res.statusCode = next.status;
        res.setHeader('content-type', 'application/json');
        // Every response carries a provider-side request ID so reconciliation
        // tests (J06) can capture it from timeout responses.
        res.setHeader('x-request-id', `mock-req-${requests.length}`);
        for (const [name, value] of Object.entries(next.headers ?? {})) {
          res.setHeader(name, value);
        }
        res.end(next.body);
      };
      if (delayMs > 0) {
        setTimeout(respond, delayMs);
      } else {
        respond();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requests,
        scriptResponses(responses): void {
          scripted = responses;
        },
        setDelayMs(delay): void {
          delayMs = delay;
        },
        close(): Promise<void> {
          return new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          });
        },
      });
    });
  });
}

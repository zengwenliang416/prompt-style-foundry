import { redactValue } from '@onepic/contracts';

/**
 * Structured worker logging (O02). Every event passes through the shared
 * redaction rules before printing, so no call site can leak credentials,
 * session material, prompt bodies, or signed-URL signatures into stdout.
 */
export function logEvent(event: string, fields?: Record<string, unknown>): void {
  console.log(JSON.stringify(redactValue({ event, ...fields })));
}

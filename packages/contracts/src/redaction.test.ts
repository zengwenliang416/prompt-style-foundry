import { describe, expect, it } from 'vitest';

import { REDACTED, redactText, redactValue } from './redaction.js';

/**
 * O02 redaction rules: sentinel credentials/prompt bodies must never survive
 * in any shape, while hashes and other observability data stay intact.
 */

const SENTINEL_KEY = ['sk', 'o02-sentinel', '9f8e7d6c5b4a'].join('-');
const SENTINEL_PROMPT = 'o02 canary prompt body zqxw';
const SENTINEL_SESSION = 'o02-sentinel-session-token-value';

describe('redactText', () => {
  it('scrubs provider keys, Bearer tokens, signature params, and session cookies', () => {
    expect(redactText(`failed with key ${SENTINEL_KEY} from provider`)).toBe(
      `failed with key sk-${REDACTED} from provider`,
    );
    expect(redactText(`Authorization: Bearer ${SENTINEL_SESSION}`)).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(
      redactText(`/api/v1/media/private/r.png?owner=u&expires=123&signature=${SENTINEL_SESSION}`),
    ).toBe(`/api/v1/media/private/r.png?owner=u&expires=123&signature=${REDACTED}`);
    expect(redactText(`cookie: onepic_session=${SENTINEL_SESSION}; other=1`)).toBe(
      `cookie: onepic_session=${REDACTED}; other=1`,
    );
    // URL-encoded forms of the shapes still match (patterns are URL-safe).
    const tricky = 'o02 sentinel/session token+value';
    expect(redactText(`?signature=${encodeURIComponent(tricky)}&expires=1`)).toBe(
      `?signature=${REDACTED}&expires=1`,
    );
  });

  it('leaves ordinary text and sha256 hashes untouched (no over-redaction)', () => {
    const hash = 'a'.repeat(64);
    expect(redactText(`generation succeeded promptSha256=${hash}`)).toBe(
      `generation succeeded promptSha256=${hash}`,
    );
  });
});

describe('redactValue', () => {
  it('replaces sensitive keys at any depth, case-insensitively', () => {
    const payload = {
      headers: {
        Authorization: `Bearer ${SENTINEL_SESSION}`,
        Cookie: `onepic_session=${SENTINEL_SESSION}`,
      },
      config: { apiKey: SENTINEL_KEY, nested: [{ clientSecret: 'hunter2-hunter2' }] },
      prompt: SENTINEL_PROMPT,
      effectivePrompt: SENTINEL_PROMPT,
      signature: SENTINEL_SESSION,
      token: SENTINEL_SESSION,
    };
    const redacted = redactValue(payload) as Record<string, never>;
    const text = JSON.stringify(redacted);
    expect(text).not.toContain(SENTINEL_KEY);
    expect(text).not.toContain(SENTINEL_PROMPT);
    expect(text).not.toContain(SENTINEL_SESSION);
    expect(text).not.toContain('hunter2');
  });

  it('keeps hash fields and low-cardinality observability data intact', () => {
    const payload = {
      compiledPromptSha256: 'b'.repeat(64),
      effectivePromptSha256: 'c'.repeat(64),
      correlationId: 'corr-1',
      errorCode: 'PROVIDER_TIMEOUT_UNKNOWN',
      state: 'outcome_unknown',
    };
    expect(redactValue(payload)).toEqual(payload);
  });

  it('scrubs credential shapes inside string values and arrays', () => {
    const redacted = redactValue({ messages: [`key was ${SENTINEL_KEY}`, 'ok'] }) as {
      messages: string[];
    };
    expect(redacted.messages[0]).toBe(`key was sk-${REDACTED}`);
    expect(redacted.messages[1]).toBe('ok');
  });

  it('converts Errors to a scrubbed name/message shape without the stack', () => {
    const redacted = redactValue(new Error(`provider replied with ${SENTINEL_KEY}`)) as {
      name: string;
      message: string;
    };
    expect(redacted.name).toBe('Error');
    expect(redacted.message).toBe(`provider replied with sk-${REDACTED}`);
    expect(JSON.stringify(redacted)).not.toContain('stack');
  });

  it('passes through numbers, booleans, null, and undefined', () => {
    expect(redactValue({ n: 42, ok: true, none: null })).toEqual({ n: 42, ok: true, none: null });
    expect(redactValue(7)).toBe(7);
  });
});

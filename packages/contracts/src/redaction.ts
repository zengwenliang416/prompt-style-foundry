/**
 * Shared log-redaction rules (O02, architecture §8: logs must never contain
 * Authorization headers, API keys, image URLs' signatures, full prompts,
 * user images, or provider response bodies).
 *
 * Both the API (pino serializers) and the worker (structured console events)
 * use THIS single implementation — the layer rules (§4) forbid worker→api
 * imports, and contracts is the dependency-free package both may use.
 *
 * Two complementary mechanisms:
 * - key redaction: any object entry whose key names a credential/session/
 *   prompt-body field is replaced wholesale (case-insensitive);
 * - pattern redaction: string values are scrubbed for credential SHAPES
 *   (provider keys, Bearer tokens, signed-URL signature params, session
 *   cookies) so secrets embedded inside free text still cannot leak.
 *
 * Over-redaction guard: hash fields (*Sha256) and other non-sensitive keys
 * are deliberately NOT matched — observability data must survive.
 */

export const REDACTED = '[redacted]';

/** Lower-cased key names whose VALUES are always replaced wholesale. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apikey',
  'api_key',
  'secret',
  'clientsecret',
  'client_secret',
  'sessionsecret',
  'session_secret',
  'password',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'sessiontoken',
  'session_token',
  'signature',
  'prompt',
  'prompttext',
  'prompt_text',
  'promptbody',
  'prompt_body',
  'effectiveprompt',
  'compiledprompt',
  'rawbody',
  'imagebytes',
  'b64_json',
  'b64json',
]);

/** Credential shapes scrubbed inside any string value. */
const VALUE_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // Provider API keys (sk-…), URL-safe so encoded forms match too.
  { pattern: /sk-[A-Za-z0-9][A-Za-z0-9_-]{4,}/g, replacement: `sk-${REDACTED}` },
  { pattern: /Bearer\s+[^\s"']+/gi, replacement: `Bearer ${REDACTED}` },
  // Signed media URLs: the signature query parameter value.
  { pattern: /([?&]signature=)[^&\s"']+/g, replacement: `$1${REDACTED}` },
  // Session cookies inside free text (e.g. a serialized Cookie header).
  { pattern: /(onepic_session=)[^;\s"']+/g, replacement: `$1${REDACTED}` },
];

/** Scrubs credential shapes out of a free-text value. */
export function redactText(input: string): string {
  let output = input;
  for (const { pattern, replacement } of VALUE_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Deep-redacts a structured log payload: sensitive keys are replaced with
 * {@link REDACTED} at any depth, and every remaining string is pattern-
 * scrubbed. Errors are converted to a name/message shape with a scrubbed
 * message (stacks are dropped — they carry source lines, not signal).
 */
export function redactValue(input: unknown): unknown {
  if (input instanceof Error) {
    return { name: input.name, message: redactText(input.message) };
  }
  if (typeof input === 'string') {
    return redactText(input);
  }
  if (Array.isArray(input)) {
    return input.map((entry) => redactValue(entry));
  }
  if (typeof input === 'object' && input !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(value);
    }
    return output;
  }
  return input;
}

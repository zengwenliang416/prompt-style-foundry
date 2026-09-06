/**
 * SHA-256 helpers for prompt integrity (U05: displayed and downloaded bodies
 * must match the catalog's promptSha256).
 *
 * The build's `stable_digest` hashes the prompt WITHOUT trailing newlines
 * (the shipped .txt files end with a trailing newline), so verification
 * strips trailing newlines before hashing — matching
 * scripts/prompt_protocol.py `stable_digest(self.prompt)`.
 */

export function stablePromptBody(text: string): string {
  return text.replace(/\n+$/, '');
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyPromptHash(text: string, expectedSha256: string): Promise<boolean> {
  return (await sha256Hex(stablePromptBody(text))) === expectedSha256;
}

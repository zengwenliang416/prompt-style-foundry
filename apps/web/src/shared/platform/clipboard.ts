/**
 * Clipboard adapter. Throws on rejection so callers can surface explicit
 * feedback (U05: clipboard denial must produce a visible error toast, never
 * a silent failure).
 */
export async function copyText(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
    throw new Error('Clipboard API unavailable');
  }
  await navigator.clipboard.writeText(text);
}

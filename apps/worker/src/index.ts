/**
 * Worker process shell. Job lease/claim/heartbeat/dead-letter machinery is
 * delivered with checklist J03; provider adapters with J04. This entry only
 * proves the process starts, logs structured events, and shuts down cleanly
 * so the workspace build artifact is a real runnable, not a stub claim.
 */

let running = true;

function handleSignal(signal: NodeJS.Signals): void {
  if (!running) {
    return;
  }
  running = false;
  // In-flight job protection (no blind re-dispatch) is enforced by the lease
  // design in J03; nothing is in flight in this shell.
  console.log(JSON.stringify({ event: 'worker_stopping', signal }));
  process.exit(0);
}

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);

console.log(JSON.stringify({ event: 'worker_started' }));

// Idle keepalive until the J03 claim loop replaces it; the worker process
// must stay alive between polls.
setInterval(() => {}, 2 ** 30);

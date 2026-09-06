-- J08: cooperative cancellation. A cancel request against a RUNNING
-- generation is recorded here (the worker checks it before sending anything
-- to the provider); queued generations transition straight to 'cancelled'.
-- The flag is a fact record, never a promise: a cancel request does not
-- guarantee the provider will not bill (CANCEL_NOT_GUARANTEED).
ALTER TABLE generation ADD COLUMN cancel_requested_at timestamptz;

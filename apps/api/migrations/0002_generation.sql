-- 0002: media quarantine, uploads, prechecks, generations, attempts, results,
-- the PG job queue, and the quota ledger (backend data dictionary §1.5–1.12).

CREATE TABLE media_object (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES subject (id),
    kind text NOT NULL CHECK (kind IN ('input', 'result')),
    state text NOT NULL CHECK (state IN ('quarantine', 'ready', 'rejected', 'expired', 'deleted')),
    bucket text NOT NULL,
    object_key text NOT NULL,
    mime text,
    bytes bigint CHECK (bytes IS NULL OR bytes >= 0),
    width integer CHECK (width IS NULL OR width >= 0),
    height integer CHECK (height IS NULL OR height >= 0),
    sha256 text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT media_object_bucket_key_unique UNIQUE (bucket, object_key)
);

CREATE INDEX media_object_owner_kind_idx ON media_object (owner_id, kind);
CREATE INDEX media_object_state_expires_idx ON media_object (state, expires_at);

CREATE TABLE upload (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    media_object_id uuid NOT NULL UNIQUE REFERENCES media_object (id),
    declared_bytes bigint NOT NULL CHECK (declared_bytes >= 0),
    declared_mime text NOT NULL,
    confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE precheck (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id uuid NOT NULL REFERENCES subject (id),
    media_object_id uuid NOT NULL REFERENCES media_object (id),
    template_version_id uuid NOT NULL REFERENCES template_version (id),
    settings jsonb NOT NULL,
    result text NOT NULL CHECK (result IN ('passed', 'failed')),
    error_code text,
    error_detail text,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX precheck_subject_created_idx ON precheck (subject_id, created_at);

CREATE TABLE generation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES subject (id),
    template_version_id uuid NOT NULL REFERENCES template_version (id),
    catalog_release_id uuid NOT NULL REFERENCES catalog_release (id),
    precheck_id uuid NOT NULL REFERENCES precheck (id),
    input_object_id uuid NOT NULL REFERENCES media_object (id),
    input_sha256 text NOT NULL,
    compiled_prompt_sha256 text NOT NULL,
    effective_prompt_sha256 text NOT NULL,
    provider_id text NOT NULL,
    model text NOT NULL,
    settings jsonb NOT NULL,
    idempotency_key text NOT NULL,
    state text NOT NULL CHECK (state IN ('created', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired', 'outcome_unknown')),
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT generation_owner_idempotency_unique UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX generation_owner_created_idx ON generation (owner_id, created_at DESC);
CREATE INDEX generation_state_idx ON generation (state);

CREATE TABLE attempt (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    generation_id uuid NOT NULL REFERENCES generation (id),
    attempt_no integer NOT NULL CHECK (attempt_no >= 1),
    sent_prompt_sha256 text NOT NULL,
    provider_request_id text,
    state text NOT NULL CHECK (state IN ('sent', 'accepted', 'succeeded', 'failed', 'unknown')),
    error_code text,
    http_status integer,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    CONSTRAINT attempt_generation_no_unique UNIQUE (generation_id, attempt_no)
);

CREATE INDEX attempt_provider_request_idx ON attempt (provider_request_id);

CREATE TABLE result (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    generation_id uuid NOT NULL UNIQUE REFERENCES generation (id),
    attempt_id uuid NOT NULL REFERENCES attempt (id),
    media_object_id uuid NOT NULL REFERENCES media_object (id),
    actual_mime text NOT NULL,
    actual_bytes bigint NOT NULL CHECK (actual_bytes >= 0),
    actual_width integer NOT NULL CHECK (actual_width >= 0),
    actual_height integer NOT NULL CHECK (actual_height >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    generation_id uuid NOT NULL REFERENCES generation (id),
    kind text NOT NULL,
    state text NOT NULL CHECK (state IN ('pending', 'leased', 'done', 'dead')),
    lease_owner text,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
    run_after timestamptz NOT NULL DEFAULT now(),
    dead_reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_state_run_after_idx ON job (state, run_after);
CREATE INDEX job_lease_expires_idx ON job (lease_expires_at);

CREATE TABLE quota_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id uuid NOT NULL REFERENCES subject (id),
    generation_id uuid NOT NULL REFERENCES generation (id),
    delta integer NOT NULL,
    reason text NOT NULL CHECK (reason IN ('reserve', 'release', 'refund')),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Idempotent accounting: one reservation/release/refund per task (B05).
    CONSTRAINT quota_ledger_generation_reason_unique UNIQUE (generation_id, reason)
);

CREATE INDEX quota_ledger_subject_idx ON quota_ledger (subject_id);

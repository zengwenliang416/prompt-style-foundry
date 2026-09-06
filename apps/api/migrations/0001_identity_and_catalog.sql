-- 0001: identity subjects, opaque sessions, immutable catalog releases and
-- template versions (backend data dictionary §1.1–1.4).

CREATE TABLE subject (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer text NOT NULL,
    subject_claim text NOT NULL,
    role text NOT NULL CHECK (role IN ('guest', 'member', 'admin')),
    created_at timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz,
    CONSTRAINT subject_issuer_claim_unique UNIQUE (issuer, subject_claim)
);

CREATE TABLE session (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id uuid NOT NULL REFERENCES subject (id) ON DELETE CASCADE,
    token_sha256 text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    rotated_from uuid REFERENCES session (id)
);

CREATE INDEX session_subject_idx ON session (subject_id);
CREATE INDEX session_expires_idx ON session (expires_at);

CREATE TABLE catalog_release (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_version text NOT NULL,
    source_sha256 text NOT NULL,
    library_sha256 text NOT NULL UNIQUE,
    template_count integer NOT NULL CHECK (template_count >= 0),
    imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE template_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog_release_id uuid NOT NULL REFERENCES catalog_release (id),
    template_key text NOT NULL,
    version integer NOT NULL CHECK (version >= 1),
    compiled_prompt_sha256 text NOT NULL,
    blueprint_sha256 text NOT NULL,
    metadata jsonb NOT NULL,
    CONSTRAINT template_version_key_version_unique UNIQUE (template_key, version),
    -- Immutable content: the same compiled prompt content must not produce a
    -- second version for the same template key (M05 rewrite flow instead).
    CONSTRAINT template_version_key_prompt_unique UNIQUE (template_key, compiled_prompt_sha256)
);

CREATE INDEX template_version_release_idx ON template_version (catalog_release_id);

-- 0003: collections, collection items, audit events, deletion manifests
-- (backend data dictionary §1.13–1.15).

CREATE TABLE collection (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES subject (id),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT collection_owner_name_unique UNIQUE (owner_id, name)
);

CREATE INDEX collection_owner_idx ON collection (owner_id);

CREATE TABLE collection_item (
    collection_id uuid NOT NULL REFERENCES collection (id) ON DELETE CASCADE,
    item_type text NOT NULL CHECK (item_type IN ('template', 'generation')),
    item_key text NOT NULL,
    added_at timestamptz NOT NULL DEFAULT now(),
    -- Idempotent favoriting (W03): repeating an insert is a no-op.
    CONSTRAINT collection_item_pk PRIMARY KEY (collection_id, item_type, item_key)
);

CREATE TABLE audit_event (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id uuid REFERENCES subject (id),
    action text NOT NULL,
    object_type text NOT NULL,
    object_id text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_event_created_idx ON audit_event (created_at);
CREATE INDEX audit_event_actor_idx ON audit_event (actor_id);

CREATE TABLE deletion_manifest (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    media_object_id uuid NOT NULL REFERENCES media_object (id),
    deleted_at timestamptz NOT NULL DEFAULT now(),
    reason text NOT NULL
);

CREATE INDEX deletion_manifest_media_idx ON deletion_manifest (media_object_id);

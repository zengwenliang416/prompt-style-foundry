# Static Catalog Architecture

## Goal

Preserve a maintainable, standalone catalog of single-image transformation prompts without inheriting the upstream application's code or runtime architecture. This document covers the compiler and `public/` static boundary; the implemented five-page/API/Worker architecture is documented in [`full-stack-architecture.md`](full-stack-architecture.md).

## Data flow

```text
Upstream ZIP (read-only)
        │
        ▼
scripts/import_source.py
        │
        ├── data/source/cases.json
        ├── data/source/framework-prompts.json
        ├── data/source/source-manifest.json
        └── public/previews/*.webp
        │
        ▼
scripts/build_library.py
        │
        ├── data/library/templates.json
        ├── public/data/catalog.json
        └── public/data/prompts/*.txt
        │
        ▼
Static `public/` application + Vue catalog consumer
```

## Why the static boundary remains mandatory

Browsing, filtering and copying prompt templates must not depend on accounts, databases, API availability or runtime secrets. The static architecture provides:

- zero runtime secrets for catalog-only deployment;
- no required user account or data collection;
- easy offline/local use;
- deterministic generated artifacts;
- deployment to any static host.

## Implemented full-stack extension

The repository now also contains an optional first-party API/BFF, PostgreSQL metadata and job table, independent Worker, private-storage port and five-page Vue application. This controlled boundary was approved in ADR 0003 and is implemented without replacing the compiler or generated static catalog.

The frontend supports `catalog-only`, `direct-BYOK` and `managed-generation`. If the API is unavailable, catalog data and prompt copy continue to work. Managed generation requires trusted OIDC, server-side opaque sessions, object authorization, quota/concurrency controls and an allowlisted Provider; it refuses to start without identity configuration.

Implementation is locally verified and has not been deployed. Under an explicit one-request paid-call authorization, W06 also verified one real Provider path (`motion-cover`, `gpt-image-2/high`, one PNG and one template); this does not establish capacity, all-format compatibility, S3 behavior, or production readiness. Phase-one storage is `LocalDiskStorage`; production S3-compatible integration remains an explicit unverified boundary.

## Optional generation adapter

Image generation is decoupled from the prompt catalog and requires an explicit user trigger:

- **catalog-only:** no image or prompt is sent anywhere.
- **direct-BYOK:** the browser stores the user-configured endpoint and key only in localStorage and calls that endpoint directly. CORS failures are reported; OnePic does not add a server proxy for BYOK.
- **managed-generation:** the browser sends to the first-party API under an authenticated opaque session; the Worker injects server-owned credentials and may call only configured allowlist Providers. Browser BYOK credentials are never migrated or forwarded.
- All three modes read the same immutable template ID/version/prompt hash. The public catalog and validation pipeline do not depend on generation availability.

## Boundaries

### Importer

Understands the upstream ZIP layout and repairs one known malformed Markdown fence deterministically. No other module needs to know upstream file paths.

### Protocol compiler

Owns the one-image rules, category-specific adaptation, output mode detection, and original blueprint input-mode classification. This is the domain core.

### Generated library

Acts as the stable integration contract for other applications. Consumers can read the full JSON, JSON catalog, or individual TXT files. `blueprintInputMode` preserves whether the upstream blueprint was originally text-to-image or image-to-image while every compiled OnePic prompt remains single-reference-image.

### Browser consumers

Both the legacy `public/` interface and Vue app load catalog metadata at startup and fetch full prompt TXT bodies on demand. The Vue app additionally uses `@onepic/client` for managed APIs; neither browser application imports API internals or mutates generated catalog data.

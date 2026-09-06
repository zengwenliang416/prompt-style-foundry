# Architecture

## Goal

Provide a maintainable, standalone catalog of single-image transformation prompts without inheriting the upstream application's code or runtime architecture.

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
Static browser application
```

## Why static

The current product requirement is browsing and copying prompt templates. A backend would add deployment, privacy, security, and maintenance costs without improving that workflow. The static architecture provides:

- zero runtime secrets;
- no user account or data collection;
- easy offline/local use;
- deterministic generated artifacts;
- deployment to any static host.

## Evolution target

The repository currently has no business backend. The recommended evolution is
an optional API service introduced only when requirements need server-owned
credentials, accounts, durable generation history, quotas, or asynchronous
jobs. The target boundary is documented in
[`full-stack-architecture.md`](full-stack-architecture.md); it does not change
the current static deployment until that service is implemented and adopted.

The frontend must continue to work in catalog-only mode. A future API is an
adapter for generation and persistence, not a replacement for the deterministic
prompt compiler or the read-only source archive.

## Optional generation adapter

Image generation exists as an optional BYOK adapter behind a clear boundary; it is not coupled to the prompt catalog.

- The browser holds the endpoint URL and API key only in localStorage.
- When the user explicitly uploads one reference image and clicks generate, the browser calls `{baseUrl}/v1/images/edits` directly with the compiled prompt. Nothing passes through project infrastructure because none exists.
- The catalog, prompts, previews, and validation pipeline never depend on this feature. Without configuration the site remains a pure template browser.
- CORS is delegated to the target service. If it blocks cross-origin requests, generation fails with an explanatory message instead of introducing a proxy.

## Boundaries

### Importer

Understands the upstream ZIP layout and repairs one known malformed Markdown fence deterministically. No other module needs to know upstream file paths.

### Protocol compiler

Owns the one-image rules, category-specific adaptation, output mode detection, and original blueprint input-mode classification. This is the domain core.

### Generated library

Acts as the stable integration contract for other applications. Consumers can read the full JSON, JSON catalog, or individual TXT files. `blueprintInputMode` preserves whether the upstream blueprint was originally text-to-image or image-to-image while every compiled OnePic prompt remains single-reference-image.

### Browser

Loads only metadata at startup and fetches a full prompt on demand. This avoids placing the entire multi-megabyte prompt corpus into the initial page payload.

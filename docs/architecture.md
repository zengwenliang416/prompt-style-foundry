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

Image generation can later be introduced as a separate adapter behind a clearly defined service boundary. It should not be coupled to the prompt catalog.

## Boundaries

### Importer

Understands the upstream ZIP layout and repairs one known malformed Markdown fence deterministically. No other module needs to know upstream file paths.

### Protocol compiler

Owns the one-image rules and category-specific adaptation. This is the domain core.

### Generated library

Acts as the stable integration contract for other applications. Consumers can read the full JSON, JSON catalog, or individual TXT files.

### Browser

Loads only metadata at startup and fetches a full prompt on demand. This avoids placing the entire multi-megabyte prompt corpus into the initial page payload.

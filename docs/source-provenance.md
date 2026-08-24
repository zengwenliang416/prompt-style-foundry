# Source provenance

## Canonical imported sources

Only two prompt-bearing upstream sources are treated as canonical:

1. `data/cases.json` — 529 case prompts.
2. `docs/templates.md` — 47 fenced framework prompt blocks.

Gallery Markdown files duplicate case content and are not imported again.

## Markdown recovery

The imported `docs/templates.md` has 47 opening fences but 46 closing fences. The missing close occurs before the Chinese conceptual typography template. The importer recovers that block by ending it at the next bold template heading and records:

```json
"recoveredMissingFence": true
```

Exactly one recovered block is required by validation. This prevents silent parsing drift.

## Archive verification

Imported archive SHA-256:

```text
ca672924e47630ac8d30c1155544fa60b052b4af74b2074fef158490a92b4d8d
```

The import manifest asserts `sourceReadOnly: true`.

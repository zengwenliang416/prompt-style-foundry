# Data model

## Full library

`data/library/templates.json` contains source blueprints and compiled prompts.

```json
{
  "schemaVersion": "1.0.0",
  "stats": {
    "total": 576,
    "cases": 529,
    "frameworks": 47
  },
  "templates": []
}
```

## Template record

```json
{
  "id": "case-532",
  "title": "六宫格柠檬饮料微缩广告",
  "kind": "case",
  "category": "Products & E-commerce",
  "styles": ["UI", "Poster", "Realistic"],
  "scenes": ["Tech", "Commerce", "Social"],
  "tags": [],
  "language": "en",
  "mode": "multi-panel",
  "requiresText": true,
  "preview": "previews/case-532.webp",
  "source": {},
  "blueprintSha256": "…",
  "promptSha256": "…",
  "blueprint": "…",
  "prompt": "…"
}
```

## Public catalog

`public/data/catalog.json` excludes full prompt bodies and points to individual TXT files. This is the browser's initial data source.

## Stability rules

- Existing IDs are immutable.
- `case-*` IDs retain upstream numeric identity.
- `framework-*` IDs follow source document order.
- Source checksums change only when upstream content changes.
- Prompt checksums change when the protocol compiler changes.

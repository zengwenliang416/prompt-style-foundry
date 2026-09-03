# Data model

## Full library

`data/library/templates.json` contains source blueprints and compiled prompts.

```json
{
  "schemaVersion": "1.1.0",
  "stats": {
    "total": 576,
    "cases": 529,
    "frameworks": 47,
    "blueprintInputModes": {
      "text-to-image": 501,
      "image-to-image": 75
    }
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
  "blueprintInputMode": "text-to-image",
  "requiresText": true,
  "preview": "previews/case-532.webp",
  "source": {},
  "blueprintSha256": "…",
  "promptSha256": "…",
  "blueprint": "…",
  "prompt": "…"
}
```

`blueprintInputMode` describes the upstream blueprint before OnePic compilation:

- `text-to-image`: the blueprint defines its subject through text or placeholders and does not explicitly depend on external visual input.
- `image-to-image`: the blueprint explicitly depends on an uploaded, attached, input, original, or reference image, a visual document, or an already supplied subject such as “this character”.

This field is provenance metadata. Every public OnePic prompt is still compiled into the required single-reference-image transformation protocol.

## Public catalog

`public/data/catalog.json` excludes full prompt bodies and points to individual TXT files. This is the browser's initial data source.
Its `stats.blueprintInputModes` and `filters.blueprintInputModes` fields power the blueprint-type count and browser filter.

## Stability rules

- Existing IDs are immutable.
- `case-*` IDs retain upstream numeric identity.
- `framework-*` IDs follow source document order.
- Source checksums change only when upstream content changes.
- Prompt checksums change when the protocol compiler changes.

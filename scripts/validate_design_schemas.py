#!/usr/bin/env python3
"""Validate D06 design examples against their JSON Schemas.

Each `examples/<name>.valid.json` must validate against
`<name>.schema.json`; each `examples/<name>.invalid-*.json` must fail.
Requires the `jsonschema` package (design-time dev tool).
"""

import json
import sys
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "docs" / "design" / "backend-schemas"
EXAMPLE_DIR = SCHEMA_DIR / "examples"


def load(path: Path):
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def main() -> int:
    failures = []
    checked = 0
    for example in sorted(EXAMPLE_DIR.glob("*.json")):
        name = example.name
        stem = name.split(".valid.json")[0] if ".valid." in name else name.split(".invalid-")[0]
        schema_path = SCHEMA_DIR / f"{stem}.schema.json"
        if not schema_path.exists():
            failures.append(f"{name}: missing schema {schema_path.name}")
            continue
        schema = load(schema_path)
        payload = load(example)
        jsonschema.Draft202012Validator.check_schema(schema)
        if ".valid." in name:
            jsonschema.validate(payload, schema)
            checked += 1
        else:
            try:
                jsonschema.validate(payload, schema)
            except jsonschema.ValidationError:
                checked += 1
            else:
                failures.append(f"{name}: expected validation failure but passed")
    for failure in failures:
        print(f"FAIL {failure}")
    print(f"Validated {checked} design examples against schemas in {SCHEMA_DIR}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

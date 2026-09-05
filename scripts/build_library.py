#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DATA_SOURCE = ROOT / "data" / "source"
DATA_LIBRARY = ROOT / "data" / "library"
PUBLIC_DATA = ROOT / "public" / "data"
PROMPT_DIR = PUBLIC_DATA / "prompts"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prompt_protocol import (  # noqa: E402
    PROJECT_NAME,
    PROJECT_NAME_ZH,
    SCHEMA_VERSION,
    SOURCE_PROJECT,
    SOURCE_REPOSITORY,
    NormalizedTemplate,
    compile_prompt,
    detect_language,
    infer_blueprint_input_mode,
    infer_mode,
    requires_text,
)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def clean_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for item in value:
        text = str(item).strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def normalize_case(case: dict[str, Any]) -> NormalizedTemplate:
    case_id = int(case["id"])
    template_id = f"case-{case_id}"
    title = str(case.get("title") or template_id).strip()
    blueprint = str(case.get("prompt") or "").strip()
    category = str(case.get("category") or "Other Use Cases")
    styles = clean_list(case.get("styles"))
    scenes = clean_list(case.get("scenes"))
    tags = clean_list(styles + scenes + [category])
    language = detect_language(blueprint)
    mode = infer_mode(category, title, blueprint)
    blueprint_input_mode = infer_blueprint_input_mode(title, blueprint)
    prompt = compile_prompt(
        template_id=template_id,
        title=title,
        category=category,
        blueprint=blueprint,
        source_kind="case",
        language=language,
        mode=mode,
        blueprint_input_mode=blueprint_input_mode,
    )
    return NormalizedTemplate(
        id=template_id,
        title=title,
        kind="case",
        category=category,
        styles=styles,
        scenes=scenes,
        tags=tags,
        language=language,
        mode=mode,
        blueprint_input_mode=blueprint_input_mode,
        requires_text=requires_text(category, title, blueprint),
        preview=f"previews/{template_id}.webp",
        source={
            "project": SOURCE_PROJECT,
            "repository": SOURCE_REPOSITORY,
            "caseId": case_id,
            "author": case.get("sourceLabel"),
            "sourceUrl": case.get("sourceUrl"),
            "galleryUrl": case.get("githubUrl"),
            "license": "MIT",
        },
        blueprint=blueprint,
        prompt=prompt,
    )


def normalize_framework(record: dict[str, Any]) -> NormalizedTemplate:
    template_id = str(record["id"])
    title = str(record.get("title") or template_id).strip()
    blueprint = str(record.get("prompt") or "").strip()
    category = str(record.get("category") or "Other Use Cases")
    styles = clean_list(record.get("styles"))
    scenes = clean_list(record.get("scenes"))
    tags = clean_list(record.get("tags"))
    language = detect_language(blueprint)
    mode = infer_mode(category, title, blueprint)
    blueprint_input_mode = infer_blueprint_input_mode(title, blueprint)
    prompt = compile_prompt(
        template_id=template_id,
        title=title,
        category=category,
        blueprint=blueprint,
        source_kind="framework",
        language=language,
        mode=mode,
        blueprint_input_mode=blueprint_input_mode,
    )
    return NormalizedTemplate(
        id=template_id,
        title=title,
        kind="framework",
        category=category,
        styles=styles,
        scenes=scenes,
        tags=tags,
        language=language,
        mode=mode,
        blueprint_input_mode=blueprint_input_mode,
        requires_text=requires_text(category, title, blueprint),
        preview=None,
        source={
            "project": SOURCE_PROJECT,
            "repository": SOURCE_REPOSITORY,
            "document": "docs/templates.md",
            "sourceUrl": record.get("sourceUrl"),
            "sourceLines": record.get("sourceLines"),
            "format": record.get("format"),
            "recoveredMissingFence": bool(record.get("recoveredMissingFence")),
            "license": "MIT",
        },
        blueprint=blueprint,
        prompt=prompt,
    )


def build_catalog_item(template: NormalizedTemplate) -> dict[str, Any]:
    generated_asset = ROOT / "data" / "generated-previews" / f"{template.id}.webp"
    generated_prompt = ROOT / "data" / "generated-previews" / f"{template.id}.prompt.txt"
    return {
        "id": template.id,
        "title": template.title,
        "kind": template.kind,
        "category": template.category,
        "styles": template.styles,
        "scenes": template.scenes,
        "tags": template.tags,
        "language": template.language,
        "mode": template.mode,
        "blueprintInputMode": template.blueprint_input_mode,
        "requiresText": template.requires_text,
        "preview": template.preview,
        "generatedPreview": f"previews/{template.id}.webp" if generated_asset.is_file() else None,
        "generatedPromptPath": f"data/generated-previews/{template.id}.prompt.txt" if generated_prompt.is_file() else None,
        "promptPath": f"data/prompts/{template.id}.txt",
        "source": template.source,
        "promptSha256": template.as_dict(include_blueprint=False, include_prompt=False)["promptSha256"],
    }


def main() -> int:
    cases_path = DATA_SOURCE / "cases.json"
    framework_path = DATA_SOURCE / "framework-prompts.json"
    manifest_path = DATA_SOURCE / "source-manifest.json"
    for path in (cases_path, framework_path, manifest_path):
        if not path.is_file():
            raise SystemExit(
                f"Missing {path.relative_to(ROOT)}. Run scripts/import_source.py first."
            )

    cases_data = read_json(cases_path)
    framework_data = read_json(framework_path)
    source_manifest = read_json(manifest_path)

    cases = [normalize_case(case) for case in cases_data["cases"]]
    frameworks = [normalize_framework(item) for item in framework_data["prompts"]]
    templates = frameworks + cases

    ids = [template.id for template in templates]
    if len(ids) != len(set(ids)):
        duplicates = [item for item, count in Counter(ids).items() if count > 1]
        raise RuntimeError(f"Duplicate template IDs: {duplicates}")

    blueprint_input_mode_counts = Counter(template.blueprint_input_mode for template in templates)

    DATA_LIBRARY.mkdir(parents=True, exist_ok=True)
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    if PROMPT_DIR.exists():
        shutil.rmtree(PROMPT_DIR)
    PROMPT_DIR.mkdir(parents=True, exist_ok=True)

    full_library = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "project": {
            "name": PROJECT_NAME,
            "nameZh": PROJECT_NAME_ZH,
            "description": "A standalone single-image prompt template library built from extracted visual blueprints.",
        },
        "source": source_manifest,
        "stats": {
            "total": len(templates),
            "cases": len(cases),
            "frameworks": len(frameworks),
            "blueprintInputModes": dict(sorted(blueprint_input_mode_counts.items())),
        },
        "templates": [template.as_dict() for template in templates],
    }
    (DATA_LIBRARY / "templates.json").write_text(
        json.dumps(full_library, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    for template in templates:
        (PROMPT_DIR / f"{template.id}.txt").write_text(template.prompt + "\n", encoding="utf-8")

    category_counts = Counter(template.category for template in templates)
    mode_counts = Counter(template.mode for template in templates)
    style_counts = Counter(style for template in templates for style in template.styles)
    scene_counts = Counter(scene for template in templates for scene in template.scenes)

    catalog = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": full_library["generatedAt"],
        "project": full_library["project"],
        "source": {
            "project": SOURCE_PROJECT,
            "repository": SOURCE_REPOSITORY,
            "archiveSha256": source_manifest.get("sourceArchiveSha256"),
            "license": "MIT",
        },
        "stats": {
            "total": len(templates),
            "cases": len(cases),
            "frameworks": len(frameworks),
            "categories": dict(sorted(category_counts.items())),
            "modes": dict(sorted(mode_counts.items())),
            "blueprintInputModes": dict(sorted(blueprint_input_mode_counts.items())),
        },
        "filters": {
            "categories": [key for key, _ in sorted(category_counts.items(), key=lambda item: (-item[1], item[0]))],
            "modes": [key for key, _ in sorted(mode_counts.items(), key=lambda item: (-item[1], item[0]))],
            "blueprintInputModes": [
                key for key, _ in sorted(blueprint_input_mode_counts.items(), key=lambda item: (-item[1], item[0]))
            ],
            "styles": [key for key, _ in sorted(style_counts.items(), key=lambda item: (-item[1], item[0]))],
            "scenes": [key for key, _ in sorted(scene_counts.items(), key=lambda item: (-item[1], item[0]))],
        },
        "templates": [build_catalog_item(template) for template in templates],
    }
    (PUBLIC_DATA / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    (PUBLIC_DATA / "stats.json").write_text(
        json.dumps(catalog["stats"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(
        f"Built {len(templates)} templates: {len(cases)} case blueprints + "
        f"{len(frameworks)} framework blueprints."
    )
    print(f"Full library: {DATA_LIBRARY / 'templates.json'}")
    print(f"Web catalog: {PUBLIC_DATA / 'catalog.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

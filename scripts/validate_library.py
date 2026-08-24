#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_SECTIONS = [
    "[System / Prompt]",
    "🧭 INSTRUCTION PRIORITY",
    "🎨 STYLE RULES",
    "🖼️ IMAGE ANALYSIS RULES",
    "🧱 CONTENT PRESERVATION RULES",
    "📐 FORMAT AND COMPOSITION",
    "🧩 TEMPLATE-SPECIFIC VISUAL BLUEPRINT",
    "--- BEGIN VISUAL BLUEPRINT ---",
    "--- END VISUAL BLUEPRINT ---",
    "🔤 TEXT RULES",
    "🚫 RESTRICTIONS",
    "🖼️ TASK",
]


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the standalone prompt library and generated web assets.")
    parser.add_argument("--expect-total", type=int, default=576)
    parser.add_argument("--expect-cases", type=int, default=529)
    parser.add_argument("--expect-frameworks", type=int, default=47)
    args = parser.parse_args()

    source_manifest = json.loads((ROOT / "data/source/source-manifest.json").read_text(encoding="utf-8"))
    library = json.loads((ROOT / "data/library/templates.json").read_text(encoding="utf-8"))
    catalog = json.loads((ROOT / "public/data/catalog.json").read_text(encoding="utf-8"))

    templates = library["templates"]
    errors: list[str] = []

    if len(templates) != args.expect_total:
        errors.append(f"template total {len(templates)} != {args.expect_total}")

    kind_counts = Counter(item["kind"] for item in templates)
    if kind_counts.get("case", 0) != args.expect_cases:
        errors.append(f"case count {kind_counts.get('case', 0)} != {args.expect_cases}")
    if kind_counts.get("framework", 0) != args.expect_frameworks:
        errors.append(f"framework count {kind_counts.get('framework', 0)} != {args.expect_frameworks}")

    ids = [item["id"] for item in templates]
    if len(ids) != len(set(ids)):
        errors.append("template IDs are not unique")

    catalog_ids = [item["id"] for item in catalog["templates"]]
    if catalog_ids != ids:
        errors.append("catalog template order or IDs do not match full library")

    prompt_dir = ROOT / "public/data/prompts"
    preview_dir = ROOT / "public/previews"

    for item in templates:
        template_id = item["id"]
        prompt = item.get("prompt", "")
        blueprint = item.get("blueprint", "")

        if not blueprint.strip():
            errors.append(f"{template_id}: empty blueprint")
        if not prompt.strip():
            errors.append(f"{template_id}: empty prompt")

        for section in REQUIRED_SECTIONS:
            if section not in prompt:
                errors.append(f"{template_id}: missing section {section}")

        if "Do not ask the user any questions." not in prompt:
            errors.append(f"{template_id}: missing no-question rule")
        if "Preserve the uploaded image's original aspect ratio" not in prompt:
            errors.append(f"{template_id}: missing aspect-ratio rule")
        if "Use Nano Banana Pro mode when available." not in prompt:
            errors.append(f"{template_id}: missing Nano Banana Pro rule")

        prompt_file = prompt_dir / f"{template_id}.txt"
        if not prompt_file.is_file():
            errors.append(f"{template_id}: missing prompt file")
        else:
            file_text = prompt_file.read_text(encoding="utf-8").rstrip("\n")
            if file_text != prompt:
                errors.append(f"{template_id}: prompt file differs from library")
            if sha256_text(prompt) != item.get("promptSha256"):
                errors.append(f"{template_id}: prompt checksum mismatch")

        if sha256_text(blueprint) != item.get("blueprintSha256"):
            errors.append(f"{template_id}: blueprint checksum mismatch")

        if item["kind"] == "case":
            preview = preview_dir / f"{template_id}.webp"
            if not preview.is_file() or preview.stat().st_size == 0:
                errors.append(f"{template_id}: missing preview")

    framework_source = json.loads((ROOT / "data/source/framework-prompts.json").read_text(encoding="utf-8"))
    recovered = [item for item in framework_source["prompts"] if item.get("recoveredMissingFence")]
    if len(recovered) != 1:
        errors.append(f"expected exactly one recovered upstream fence; found {len(recovered)}")

    if source_manifest.get("sourceReadOnly") is not True:
        errors.append("source manifest does not assert read-only extraction")
    if source_manifest.get("totalPromptCount") != args.expect_total:
        errors.append("source manifest total does not match expected total")

    if errors:
        print(f"Validation failed with {len(errors)} error(s):")
        for error in errors[:100]:
            print(f"- {error}")
        if len(errors) > 100:
            print(f"... and {len(errors) - 100} more")
        return 1

    print(
        f"Validated {len(templates)} templates: "
        f"{kind_counts['case']} case templates + {kind_counts['framework']} framework templates."
    )
    print(f"Validated {kind_counts['case']} previews and {len(templates)} standalone prompt files.")
    print(f"Source archive SHA-256: {source_manifest['sourceArchiveSha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

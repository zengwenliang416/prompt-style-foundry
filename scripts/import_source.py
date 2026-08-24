#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import shutil
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
DATA_SOURCE = ROOT / "data" / "source"
PREVIEWS = ROOT / "public" / "previews"
THIRD_PARTY = ROOT / "third_party"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prompt_protocol import SECTION_TO_CATEGORY, SOURCE_PROJECT, SOURCE_REPOSITORY  # noqa: E402

OPEN_FENCE_RE = re.compile(r"^```(text|json)\s*$")
BOLD_HEADING_RE = re.compile(r"^\*\*(.+?)\*\*\s*$")

CATEGORY_DEFAULTS: dict[str, dict[str, list[str]]] = {
    "UI & Interfaces": {"styles": ["UI"], "scenes": ["Tech"], "tags": ["UI", "Interface"]},
    "Charts & Infographics": {"styles": ["Infographic", "Charts"], "scenes": ["Education", "Tech"], "tags": ["Infographic", "Diagram"]},
    "Posters & Typography": {"styles": ["Poster"], "scenes": ["Creative", "Commerce"], "tags": ["Poster", "Typography"]},
    "Products & E-commerce": {"styles": ["Product"], "scenes": ["Commerce"], "tags": ["Product", "Advertising"]},
    "Brand & Logos": {"styles": ["Brand"], "scenes": ["Commerce", "Creative"], "tags": ["Brand", "Identity"]},
    "Architecture & Spaces": {"styles": ["Architecture"], "scenes": ["Space"], "tags": ["Architecture", "Interior"]},
    "Photography & Realism": {"styles": ["Realistic"], "scenes": ["Lifestyle"], "tags": ["Photography", "Realism"]},
    "Illustration & Art": {"styles": ["Illustration"], "scenes": ["Creative"], "tags": ["Illustration", "Art"]},
    "Characters & People": {"styles": ["Character"], "scenes": ["Portrait"], "tags": ["Character", "People"]},
    "Scenes & Storytelling": {"styles": ["Story"], "scenes": ["Story"], "tags": ["Scene", "Storytelling"]},
    "History & Classical Themes": {"styles": ["Historical"], "scenes": ["History"], "tags": ["History", "Classical"]},
    "Documents & Publishing": {"styles": ["Editorial"], "scenes": ["Publishing"], "tags": ["Document", "Publishing"]},
    "Other Use Cases": {"styles": ["Other"], "scenes": ["Creative"], "tags": ["Experimental"]},
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_member(names: list[str], suffix: str) -> str:
    matches = [name for name in names if name.endswith(suffix)]
    if len(matches) != 1:
        raise RuntimeError(f"Expected exactly one ZIP member ending in {suffix!r}; found {len(matches)}")
    return matches[0]


def extract_framework_prompts(markdown: str) -> list[dict[str, Any]]:
    lines = markdown.splitlines()
    openings = [index for index, line in enumerate(lines) if OPEN_FENCE_RE.match(line)]
    records: list[dict[str, Any]] = []

    for position, start in enumerate(openings):
        next_start = openings[position + 1] if position + 1 < len(openings) else len(lines)
        close = next((i for i in range(start + 1, next_start) if lines[i].strip() == "```"), None)
        recovered = close is None

        if close is not None:
            end = close
        else:
            # The upstream document currently has one missing closing fence. Recover by
            # ending before the nearest bold template heading that precedes the next block.
            candidate_headings = [
                i
                for i in range(start + 1, next_start)
                if BOLD_HEADING_RE.match(lines[i].strip())
            ]
            end = candidate_headings[-1] if candidate_headings else next_start

        section = "Other Use Cases"
        section_zh = "其他应用场景"
        for index in range(start - 1, -1, -1):
            if lines[index].startswith("### "):
                section_zh = lines[index][4:].strip()
                section = SECTION_TO_CATEGORY.get(section_zh, "Other Use Cases")
                break

        label = "模板"
        for index in range(start - 1, -1, -1):
            match = BOLD_HEADING_RE.match(lines[index].strip())
            if match:
                label = match.group(1).strip()
                break
            if lines[index].startswith("### "):
                break

        language = OPEN_FENCE_RE.match(lines[start]).group(1)  # type: ignore[union-attr]
        content = "\n".join(lines[start + 1 : end]).strip()
        if not content:
            raise RuntimeError(f"Empty framework prompt at source line {start + 1}")

        defaults = CATEGORY_DEFAULTS[section]
        prompt_number = position + 1
        record_id = f"framework-{prompt_number:03d}"
        title = f"{section_zh} · {label}"
        records.append(
            {
                "id": record_id,
                "title": title,
                "section": section_zh,
                "category": section,
                "styles": defaults["styles"],
                "scenes": defaults["scenes"],
                "tags": defaults["tags"] + [label, language.upper()],
                "format": language,
                "prompt": content,
                "sourceLines": {"start": start + 1, "end": end},
                "recoveredMissingFence": recovered,
                "sourceUrl": f"{SOURCE_REPOSITORY}/blob/main/docs/templates.md#L{start + 1}-L{end}",
            }
        )

    return records


def build_preview(image_bytes: bytes, destination: Path, max_dimension: int, quality: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(io.BytesIO(image_bytes)) as image:
        image = ImageOps.exif_transpose(image)
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGB")
        if image.mode == "RGBA":
            background = Image.new("RGB", image.size, "white")
            background.paste(image, mask=image.getchannel("A"))
            image = background
        image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
        image.save(destination, "WEBP", quality=quality, method=6)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read the upstream ZIP without modifying it and import only canonical prompt data into OnePic Template Studio."
    )
    parser.add_argument("zip_path", type=Path, help="Path to awesome-gpt-image-2 ZIP archive")
    parser.add_argument("--max-preview", type=int, default=640, help="Maximum preview width/height")
    parser.add_argument("--preview-quality", type=int, default=74, help="WebP quality")
    parser.add_argument("--skip-previews", action="store_true", help="Do not generate preview thumbnails")
    parser.add_argument("--force-previews", action="store_true", help="Regenerate previews even when they already exist")
    args = parser.parse_args()

    zip_path = args.zip_path.resolve()
    if not zip_path.is_file():
        parser.error(f"ZIP file does not exist: {zip_path}")

    DATA_SOURCE.mkdir(parents=True, exist_ok=True)
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    THIRD_PARTY.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path) as archive:
        names = archive.namelist()
        cases_member = find_member(names, "/data/cases.json")
        style_member = find_member(names, "/data/style-library.json")
        templates_member = find_member(names, "/docs/templates.md")
        license_member = find_member(names, "/LICENSE")

        cases_raw = archive.read(cases_member)
        style_raw = archive.read(style_member)
        templates_raw = archive.read(templates_member)
        license_raw = archive.read(license_member)

        cases_data = json.loads(cases_raw.decode("utf-8"))
        if not isinstance(cases_data.get("cases"), list):
            raise RuntimeError("Source data/cases.json does not contain a cases array")

        framework_prompts = extract_framework_prompts(templates_raw.decode("utf-8"))

        (DATA_SOURCE / "cases.json").write_bytes(cases_raw)
        (DATA_SOURCE / "style-library.json").write_bytes(style_raw)
        (DATA_SOURCE / "templates.md").write_bytes(templates_raw)
        (DATA_SOURCE / "framework-prompts.json").write_text(
            json.dumps(
                {
                    "source": SOURCE_PROJECT,
                    "repository": SOURCE_REPOSITORY,
                    "count": len(framework_prompts),
                    "prompts": framework_prompts,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        (THIRD_PARTY / "awesome-gpt-image-2-LICENSE").write_bytes(license_raw)

        preview_count = 0
        preview_failures: list[str] = []
        if not args.skip_previews:
            suffix_map = {name.rsplit("/data/images/", 1)[-1]: name for name in names if "/data/images/" in name}
            for case in cases_data["cases"]:
                image_path = str(case.get("image", "")).lstrip("/")
                basename = Path(image_path).name
                member = suffix_map.get(basename)
                if not member:
                    preview_failures.append(f"case-{case.get('id')}: missing {basename}")
                    continue
                destination = PREVIEWS / f"case-{case['id']}.webp"
                if destination.exists() and destination.stat().st_size > 0 and not args.force_previews:
                    preview_count += 1
                    continue
                try:
                    build_preview(
                        archive.read(member),
                        destination,
                        max_dimension=max(240, args.max_preview),
                        quality=min(95, max(40, args.preview_quality)),
                    )
                    preview_count += 1
                except Exception as exc:  # pragma: no cover - defensive reporting
                    preview_failures.append(f"case-{case.get('id')}: {exc}")

    manifest = {
        "schemaVersion": "1.0.0",
        "importedAt": datetime.now(timezone.utc).isoformat(),
        "sourceProject": SOURCE_PROJECT,
        "sourceRepository": SOURCE_REPOSITORY,
        "sourceArchive": zip_path.name,
        "sourceArchiveSha256": sha256_file(zip_path),
        "canonicalSources": [
            "data/cases.json",
            "docs/templates.md",
        ],
        "casePromptCount": len(cases_data["cases"]),
        "frameworkPromptCount": len(framework_prompts),
        "totalPromptCount": len(cases_data["cases"]) + len(framework_prompts),
        "previewCount": preview_count,
        "previewFailures": preview_failures,
        "sourceReadOnly": True,
    }
    (DATA_SOURCE / "source-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(
        f"Imported {manifest['casePromptCount']} case prompts and "
        f"{manifest['frameworkPromptCount']} framework prompts "
        f"({manifest['totalPromptCount']} total)."
    )
    if args.skip_previews:
        print("Preview generation skipped.")
    else:
        print(f"Generated {preview_count} WebP previews.")
    if preview_failures:
        print(f"Warning: {len(preview_failures)} preview failures", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

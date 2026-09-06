#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "data" / "generated-previews"
MANIFEST_PATH = SOURCE_DIR / "manifest.json"
PUBLIC_PREVIEWS = ROOT / "public" / "previews"
CATALOG_PATH = ROOT / "public" / "data" / "catalog.json"
PUBLIC_GENERATED_PROMPTS = ROOT / "public" / "data" / "generated-previews"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.is_file():
        return {"schemaVersion": "1.0.0", "entries": []}
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def validated_entries(manifest: dict[str, Any]) -> list[tuple[dict[str, Any], Path, Path]]:
    if manifest.get("schemaVersion") != "1.0.0":
        raise ValueError("generated preview manifest schemaVersion must be 1.0.0")

    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise ValueError("generated preview manifest entries must be a list")

    seen_ids: set[str] = set()
    validated: list[tuple[dict[str, Any], Path, Path]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("generated preview manifest entries must be objects")

        template_id = str(entry.get("templateId", ""))
        valid_case = template_id.startswith("case-") and template_id[5:].isdigit()
        valid_framework = template_id.startswith("framework-") and template_id[10:].isdigit()
        if not (valid_case or valid_framework):
            raise ValueError(f"invalid generated preview templateId: {template_id!r}")
        if template_id in seen_ids:
            raise ValueError(f"duplicate generated preview templateId: {template_id}")
        seen_ids.add(template_id)

        asset = str(entry.get("asset", ""))
        expected_asset = f"{template_id}.webp"
        if asset != expected_asset:
            raise ValueError(f"{template_id}: asset must be {expected_asset}")

        source = SOURCE_DIR / asset
        destination = PUBLIC_PREVIEWS / expected_asset
        if not source.is_file() or source.stat().st_size == 0:
            raise ValueError(f"{template_id}: missing generated preview source")

        expected_sha256 = str(entry.get("sha256", ""))
        actual_sha256 = sha256_file(source)
        if actual_sha256 != expected_sha256:
            raise ValueError(f"{template_id}: generated preview checksum mismatch")

        with Image.open(source) as image:
            if image.format != "WEBP":
                raise ValueError(f"{template_id}: generated preview source is not WebP")
            expected_size = entry.get("size")
            if expected_size != [image.width, image.height]:
                raise ValueError(f"{template_id}: generated preview dimensions mismatch")

        prompt_override = entry.get("promptOverride")
        if prompt_override is not None:
            if prompt_override != f"{template_id}.prompt-override.json":
                raise ValueError(f"{template_id}: invalid prompt override path")
            if not (SOURCE_DIR / prompt_override).is_file():
                raise ValueError(f"{template_id}: prompt override record is missing")

        validated.append((entry, source, destination))

    return validated


def referenced_prompt_sidecars() -> list[Path]:
    """Prompt sidecar paths the public catalog references via generatedPromptPath.

    The catalog promises `data/generated-previews/{id}.prompt.txt` (the actual
    prompt behind each reviewed sample preview); those files must ship with the
    public payload or the reference dangles. Runs after build_library.py in the
    build pipeline, so the catalog is fresh.
    """
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    paths: list[Path] = []
    for template in catalog.get("templates", []):
        relative = template.get("generatedPromptPath")
        if not relative:
            continue
        if not relative.startswith("data/generated-previews/") or ".." in relative:
            raise ValueError(f"{template.get('id')}: unexpected generatedPromptPath {relative!r}")
        paths.append(ROOT / relative)
    return paths


def install_prompt_sidecars(check: bool) -> int:
    sidecars = referenced_prompt_sidecars()
    if check:
        for path in sidecars:
            public_path = PUBLIC_GENERATED_PROMPTS / path.name
            if not public_path.is_file() or public_path.read_bytes() != path.read_bytes():
                raise SystemExit(f"{path.name}: public prompt sidecar is missing or differs")
    else:
        PUBLIC_GENERATED_PROMPTS.mkdir(parents=True, exist_ok=True)
        for path in sidecars:
            if not path.is_file():
                raise SystemExit(f"{path.name}: referenced prompt sidecar is missing")
            destination = PUBLIC_GENERATED_PROMPTS / path.name
            temporary = destination.with_suffix(".txt.tmp")
            shutil.copyfile(path, temporary)
            temporary.replace(destination)
    return len(sidecars)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install reviewed generated previews into the public catalog."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify public previews match the reviewed sources without writing files.",
    )
    args = parser.parse_args()

    entries = validated_entries(read_manifest())
    PUBLIC_PREVIEWS.mkdir(parents=True, exist_ok=True)

    for entry, source, destination in entries:
        template_id = entry["templateId"]
        if args.check:
            if not destination.is_file():
                raise SystemExit(f"{template_id}: public preview is missing")
            if sha256_file(destination) != entry["sha256"]:
                raise SystemExit(f"{template_id}: public preview differs from reviewed source")
            continue

        temporary = destination.with_suffix(".webp.tmp")
        shutil.copyfile(source, temporary)
        temporary.replace(destination)

    action = "Verified" if args.check else "Installed"
    sidecar_count = install_prompt_sidecars(args.check)
    print(f"{action} {len(entries)} reviewed generated previews.")
    print(f"{action} {sidecar_count} generated prompt sidecars.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

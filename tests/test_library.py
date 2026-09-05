from __future__ import annotations

import hashlib
import json
import unittest
from collections import Counter
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class GeneratedLibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.library = json.loads((ROOT / "data/library/templates.json").read_text(encoding="utf-8"))
        cls.catalog = json.loads((ROOT / "public/data/catalog.json").read_text(encoding="utf-8"))
        cls.public_stats = json.loads((ROOT / "public/data/stats.json").read_text(encoding="utf-8"))

    def test_expected_counts(self) -> None:
        templates = self.library["templates"]
        counts = Counter(item["kind"] for item in templates)
        self.assertEqual(self.library["schemaVersion"], "1.1.0")
        self.assertEqual(self.catalog["schemaVersion"], "1.1.0")
        self.assertEqual(len(templates), 576)
        self.assertEqual(counts["case"], 529)
        self.assertEqual(counts["framework"], 47)

    def test_unique_ids(self) -> None:
        ids = [item["id"] for item in self.library["templates"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_catalog_matches_library(self) -> None:
        library_ids = [item["id"] for item in self.library["templates"]]
        catalog_ids = [item["id"] for item in self.catalog["templates"]]
        self.assertEqual(catalog_ids, library_ids)

    def test_blueprint_input_modes_are_complete(self) -> None:
        templates = self.library["templates"]
        counts = Counter(item["blueprintInputMode"] for item in templates)
        self.assertEqual(set(counts), {"text-to-image", "image-to-image"})
        self.assertEqual(counts["text-to-image"], 493)
        self.assertEqual(counts["image-to-image"], 83)
        self.assertEqual(sum(counts.values()), len(templates))
        self.assertEqual(self.library["stats"]["blueprintInputModes"], dict(sorted(counts.items())))
        self.assertEqual(self.catalog["stats"]["blueprintInputModes"], dict(sorted(counts.items())))
        self.assertEqual(self.public_stats, self.catalog["stats"])
        self.assertEqual(
            self.catalog["filters"]["blueprintInputModes"],
            [key for key, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))],
        )
        catalog_modes = {item["id"]: item["blueprintInputMode"] for item in self.catalog["templates"]}
        for item in templates:
            self.assertEqual(catalog_modes[item["id"]], item["blueprintInputMode"])

    def test_every_template_has_public_prompt(self) -> None:
        for item in self.catalog["templates"]:
            path = ROOT / "public" / item["promptPath"]
            self.assertTrue(path.is_file(), item["id"])
            self.assertGreater(path.stat().st_size, 1000, item["id"])

    def test_every_case_has_preview(self) -> None:
        for item in self.catalog["templates"]:
            if item["kind"] != "case":
                continue
            preview = ROOT / "public" / item["preview"]
            self.assertTrue(preview.is_file(), item["id"])
            self.assertGreater(preview.stat().st_size, 0, item["id"])

    def test_reviewed_generated_previews_match_public_assets(self) -> None:
        source_dir = ROOT / "data/generated-previews"
        manifest = json.loads((source_dir / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schemaVersion"], "1.0.0")
        self.assertGreater(len(manifest["entries"]), 0)

        template_ids: set[str] = set()
        for entry in manifest["entries"]:
            template_id = entry["templateId"]
            self.assertNotIn(template_id, template_ids)
            template_ids.add(template_id)

            source = source_dir / entry["asset"]
            public = ROOT / "public/previews" / entry["asset"]
            self.assertTrue(source.is_file(), template_id)
            self.assertTrue(public.is_file(), template_id)
            self.assertEqual(sha256_file(source), entry["sha256"], template_id)
            self.assertEqual(sha256_file(public), entry["sha256"], template_id)

            with Image.open(source) as image:
                self.assertEqual(image.format, "WEBP", template_id)
                self.assertEqual([image.width, image.height], entry["size"], template_id)

            prompt_override = entry.get("promptOverride")
            if prompt_override is not None:
                self.assertEqual(prompt_override, f"{template_id}.prompt-override.json")
                self.assertTrue((source_dir / prompt_override).is_file(), template_id)


if __name__ == "__main__":
    unittest.main()

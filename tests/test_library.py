from __future__ import annotations

import json
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class GeneratedLibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.library = json.loads((ROOT / "data/library/templates.json").read_text(encoding="utf-8"))
        cls.catalog = json.loads((ROOT / "public/data/catalog.json").read_text(encoding="utf-8"))

    def test_expected_counts(self) -> None:
        templates = self.library["templates"]
        counts = Counter(item["kind"] for item in templates)
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


if __name__ == "__main__":
    unittest.main()

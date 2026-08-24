from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class SourceExtractionTests(unittest.TestCase):
    def test_framework_prompt_count_and_recovery(self) -> None:
        data = json.loads((ROOT / "data/source/framework-prompts.json").read_text(encoding="utf-8"))
        self.assertEqual(data["count"], 47)
        recovered = [item for item in data["prompts"] if item["recoveredMissingFence"]]
        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0]["id"], "framework-013")
        self.assertIn("签名练习拆解图模板", recovered[0]["title"])

    def test_manifest_declares_read_only_import(self) -> None:
        manifest = json.loads((ROOT / "data/source/source-manifest.json").read_text(encoding="utf-8"))
        self.assertTrue(manifest["sourceReadOnly"])
        self.assertEqual(manifest["casePromptCount"], 529)
        self.assertEqual(manifest["frameworkPromptCount"], 47)
        self.assertEqual(manifest["totalPromptCount"], 576)
        self.assertEqual(
            manifest["sourceArchiveSha256"],
            "ca672924e47630ac8d30c1155544fa60b052b4af74b2074fef158490a92b4d8d",
        )


if __name__ == "__main__":
    unittest.main()

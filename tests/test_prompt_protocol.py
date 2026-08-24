from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from prompt_protocol import compile_prompt, detect_language, infer_mode, requires_text  # noqa: E402


class PromptProtocolTests(unittest.TestCase):
    def test_compiled_prompt_has_required_precedence(self) -> None:
        prompt = compile_prompt(
            template_id="test-001",
            title="测试海报",
            category="Posters & Typography",
            blueprint="Create a 9:16 poster for [COUNTRY] titled SAMPLE.",
            source_kind="framework",
        )
        self.assertTrue(prompt.startswith("[System / Prompt]"))
        self.assertIn("The uploaded image controls WHAT is depicted.", prompt)
        self.assertIn("Preserve the uploaded image's original aspect ratio", prompt)
        self.assertIn("--- BEGIN VISUAL BLUEPRINT ---", prompt)
        self.assertIn("Create a 9:16 poster for [COUNTRY] titled SAMPLE.", prompt)
        self.assertIn("Do not ask the user any questions.", prompt)
        self.assertIn("Return only the finished image.", prompt)

    def test_mode_detection(self) -> None:
        self.assertEqual(
            infer_mode("Products & E-commerce", "六宫格产品广告", "strict 2 x 3 grid with six panels"),
            "multi-panel",
        )
        self.assertEqual(infer_mode("UI & Interfaces", "App", "single screen"), "interface")
        self.assertEqual(infer_mode("Illustration & Art", "水彩", "soft watercolor"), "single-scene")

    def test_language_detection(self) -> None:
        self.assertEqual(detect_language("生成一张高级中文海报，保留大量留白。"), "zh")
        self.assertEqual(detect_language("Create a refined editorial poster."), "en")

    def test_text_detection(self) -> None:
        self.assertTrue(requires_text("Posters & Typography", "海报", "minimal"))
        self.assertFalse(requires_text("Photography & Realism", "街景摄影", "35mm shallow depth of field"))


if __name__ == "__main__":
    unittest.main()

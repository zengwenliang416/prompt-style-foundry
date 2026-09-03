from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from prompt_protocol import (  # noqa: E402
    compile_prompt,
    detect_language,
    infer_blueprint_input_mode,
    infer_mode,
    requires_text,
)


class PromptProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        source = json.loads((ROOT / "data/source/cases.json").read_text(encoding="utf-8"))
        cls.cases = {item["id"]: item for item in source["cases"]}

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
        self.assertIn("Source blueprint input mode: text-to-image", prompt)
        self.assertIn("--- BEGIN VISUAL BLUEPRINT ---", prompt)
        self.assertIn("Create a 9:16 poster for [COUNTRY] titled SAMPLE.", prompt)
        self.assertIn("Do not ask the user any questions.", prompt)
        self.assertIn("Return only the finished image.", prompt)

    def test_blueprint_input_mode_detection(self) -> None:
        self.assertEqual(
            infer_blueprint_input_mode("照片重绘", "Transform the uploaded image into a paper collage."),
            "image-to-image",
        )
        self.assertEqual(
            infer_blueprint_input_mode("角色插画", "参考图是角色人设图，请为参考图中的少女绘制插画。"),
            "image-to-image",
        )
        self.assertEqual(
            infer_blueprint_input_mode("海报", "Generate a premium poster for a fictional summer festival."),
            "text-to-image",
        )
        self.assertEqual(
            infer_blueprint_input_mode("广告", "Designed with GPT Image 2. Preserve the original logo design language."),
            "text-to-image",
        )

    def test_real_image_to_image_cases_do_not_regress(self) -> None:
        for case_id in (212, 270, 297, 306, 317, 318, 357, 381, 382, 387, 404, 416):
            item = self.cases[case_id]
            with self.subTest(case_id=case_id):
                self.assertEqual(
                    infer_blueprint_input_mode(item["title"], item["prompt"]),
                    "image-to-image",
                )

    def test_real_text_to_image_cases_do_not_regress(self) -> None:
        for case_id in (267, 415, 516):
            item = self.cases[case_id]
            with self.subTest(case_id=case_id):
                self.assertEqual(
                    infer_blueprint_input_mode(item["title"], item["prompt"]),
                    "text-to-image",
                )

    def test_reference_language_without_an_input_image_stays_text_to_image(self) -> None:
        examples = (
            "Create a reference-style sustainable transportation infographic.",
            "Create a clean character reference sheet with front, side, and back views.",
            'Caption text: "recipe attached". The attached image is a painted bowl of food.',
            "If company materials exist, users may optionally upload an old brochure.",
            "无需用户上传 Logo 和产品素材，由 AI 自动识别品牌。",
        )
        for blueprint in examples:
            with self.subTest(blueprint=blueprint):
                self.assertEqual(
                    infer_blueprint_input_mode("测试", blueprint),
                    "text-to-image",
                )

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

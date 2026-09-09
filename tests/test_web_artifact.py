import tempfile
import unittest
from pathlib import Path

from scripts import create_web_artifact


class WebArtifactPolicyTest(unittest.TestCase):
    def setUp(self):
        self.original_web_dist = create_web_artifact.WEB_DIST
        self.original_public = create_web_artifact.PUBLIC
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        create_web_artifact.WEB_DIST = root / "dist"
        create_web_artifact.PUBLIC = root / "public"

    def tearDown(self):
        create_web_artifact.WEB_DIST = self.original_web_dist
        create_web_artifact.PUBLIC = self.original_public
        self.temporary.cleanup()

    def write_web(self, relative: str, body: bytes = b"safe") -> None:
        target = create_web_artifact.WEB_DIST / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)

    def write_public(self, relative: str, body: bytes = b"safe") -> None:
        target = create_web_artifact.PUBLIC / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)

    def seed_valid_layout(self) -> None:
        self.write_web("index.html", b"<div id='app'></div>")
        self.write_web("assets/index-abc.js", b"console.log('ok')")
        self.write_web("assets/index-abc.css", b"body{}")
        self.write_public("data/catalog.json", b"{}")
        self.write_public("data/stats.json", b"{}")
        self.write_public("data/prompts/case-1.txt")
        self.write_public("data/prompts/framework-001.txt")
        self.write_public("data/generated-previews/framework-001.prompt.txt")
        self.write_public("previews/case-1.webp")
        self.write_public("previews/framework-001.webp")

    def test_combines_vue_bundles_with_catalog_assets_only(self):
        self.seed_valid_layout()
        found = {relative for _, relative in create_web_artifact.artifact_files()}
        self.assertEqual(
            found,
            {
                "index.html",
                "assets/index-abc.js",
                "assets/index-abc.css",
                "data/catalog.json",
                "data/stats.json",
                "data/prompts/case-1.txt",
                "data/prompts/framework-001.txt",
                "data/generated-previews/framework-001.prompt.txt",
                "previews/case-1.webp",
                "previews/framework-001.webp",
            },
        )

    def test_rejects_source_maps_and_unexpected_catalog_files(self):
        self.seed_valid_layout()
        for root, relative in (
            (create_web_artifact.WEB_DIST, "assets/index.js.map"),
            (create_web_artifact.PUBLIC, "data/debug.json"),
            (create_web_artifact.PUBLIC, "previews/debug.webp"),
        ):
            with self.subTest(relative=relative):
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"unexpected")
                with self.assertRaisesRegex(SystemExit, "not allowlisted"):
                    create_web_artifact.artifact_files()
                target.unlink()

    def test_rejects_credentials_without_echoing_secret_value(self):
        self.seed_valid_layout()
        secret = b"PROVIDER_API_KEY=do-not-package-this-value"
        self.write_web("assets/index-abc.js", secret)
        with self.assertRaises(SystemExit) as raised:
            create_web_artifact.artifact_files()
        self.assertIn("Credential-like content", str(raised.exception))
        self.assertNotIn("do-not-package-this-value", str(raised.exception))

    def test_requires_vue_javascript_and_css_bundles(self):
        self.seed_valid_layout()
        (create_web_artifact.WEB_DIST / "assets/index-abc.js").unlink()
        with self.assertRaisesRegex(SystemExit, "JavaScript bundle"):
            create_web_artifact.artifact_files()
        self.write_web("assets/index-abc.js")
        (create_web_artifact.WEB_DIST / "assets/index-abc.css").unlink()
        with self.assertRaisesRegex(SystemExit, "CSS bundle"):
            create_web_artifact.artifact_files()


if __name__ == "__main__":
    unittest.main()

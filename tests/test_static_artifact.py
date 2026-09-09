import tempfile
import unittest
from pathlib import Path

from scripts import create_static_artifact
from scripts.fingerprint_paths import fingerprint


class StaticArtifactPolicyTest(unittest.TestCase):
    def setUp(self):
        self.original_public = create_static_artifact.PUBLIC
        self.temporary = tempfile.TemporaryDirectory()
        create_static_artifact.PUBLIC = Path(self.temporary.name)

    def tearDown(self):
        create_static_artifact.PUBLIC = self.original_public
        self.temporary.cleanup()

    def write(self, relative: str, body: bytes = b"safe") -> None:
        target = create_static_artifact.PUBLIC / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)

    def test_accepts_only_the_declared_static_runtime_layout(self):
        for relative in (
            "index.html",
            "favicon.svg",
            "assets/app.js",
            "assets/fx.js",
            "assets/styles.css",
            "assets/vendor/anime.esm.min.js",
            "data/catalog.json",
            "data/stats.json",
            "data/prompts/case-532.txt",
            "data/prompts/framework-001.txt",
            "data/generated-previews/framework-001.prompt.txt",
            "previews/case-1.webp",
            "previews/framework-001.webp",
        ):
            self.write(relative)
        found = {relative for _, relative in create_static_artifact.public_files()}
        self.assertEqual(
            found,
            {
                "index.html",
                "favicon.svg",
                "assets/app.js",
                "assets/fx.js",
                "assets/styles.css",
                "assets/vendor/anime.esm.min.js",
                "data/catalog.json",
                "data/stats.json",
                "data/prompts/case-532.txt",
                "data/prompts/framework-001.txt",
                "data/generated-previews/framework-001.prompt.txt",
                "previews/case-1.webp",
                "previews/framework-001.webp",
            },
        )

    def test_rejects_documentation_temporary_and_unexpected_images(self):
        for relative in ("notes.md", "debug.tmp", "preview-test.webp", "assets/app.js.map"):
            with self.subTest(relative=relative):
                self.write(relative)
                with self.assertRaisesRegex(SystemExit, "not allowlisted"):
                    create_static_artifact.public_files()
                (create_static_artifact.PUBLIC / relative).unlink()

    def test_rejects_high_confidence_credential_material_without_echoing_it(self):
        secret = b"PROVIDER_API_KEY=do-not-package-this-value"
        self.write("assets/app.js", secret)
        with self.assertRaises(SystemExit) as raised:
            create_static_artifact.public_files()
        self.assertIn("Credential-like content", str(raised.exception))
        self.assertNotIn("do-not-package-this-value", str(raised.exception))


    def test_generated_fingerprint_detects_content_and_path_drift(self):
        self.write("data/catalog.json", b"before")
        before = fingerprint([str(create_static_artifact.PUBLIC / "data")])
        self.write("data/catalog.json", b"after")
        after_content = fingerprint([str(create_static_artifact.PUBLIC / "data")])
        self.assertNotEqual(before, after_content)
        (create_static_artifact.PUBLIC / "data/catalog.json").rename(
            create_static_artifact.PUBLIC / "data/stats.json"
        )
        after_path = fingerprint([str(create_static_artifact.PUBLIC / "data")])
        self.assertNotEqual(after_content, after_path)

if __name__ == "__main__":
    unittest.main()

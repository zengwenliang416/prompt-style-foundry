import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.worktree_fingerprint import fingerprint_worktree


class WorktreeFingerprintTest(unittest.TestCase):
    def test_is_deterministic_and_covers_git_visible_path_type_and_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-q", root], check=True)
            subprocess.run(["git", "-C", root, "config", "user.name", "OnePic Test"], check=True)
            subprocess.run(
                ["git", "-C", root, "config", "user.email", "onepic-test@example.invalid"],
                check=True,
            )
            (root / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
            (root / "tracked.txt").write_bytes(b"tracked")
            subprocess.run(["git", "-C", root, "add", "."], check=True)
            subprocess.run(["git", "-C", root, "commit", "-qm", "fixture"], check=True)

            baseline = fingerprint_worktree(root)
            self.assertEqual(baseline, fingerprint_worktree(root))
            self.assertRegex(baseline, r"^[0-9a-f]{64}$")

            (root / "ignored.txt").write_bytes(b"not Git-visible")
            self.assertEqual(baseline, fingerprint_worktree(root))

            (root / "tracked.txt").write_bytes(b"changed")
            self.assertNotEqual(baseline, fingerprint_worktree(root))
            (root / "tracked.txt").write_bytes(b"tracked")

            untracked = root / "untracked.txt"
            untracked.write_bytes(b"tracked")
            untracked_hash = fingerprint_worktree(root)
            self.assertNotEqual(baseline, untracked_hash)
            untracked.rename(root / "renamed.txt")
            renamed_hash = fingerprint_worktree(root)
            self.assertNotEqual(untracked_hash, renamed_hash)

            renamed = root / "renamed.txt"
            renamed.unlink()
            try:
                os.symlink("tracked.txt", renamed)
            except (NotImplementedError, OSError):
                self.skipTest("symlinks are unavailable")
            self.assertNotEqual(renamed_hash, fingerprint_worktree(root))


if __name__ == "__main__":
    unittest.main()

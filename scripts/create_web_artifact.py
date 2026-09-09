#!/usr/bin/env python3
"""Create a deterministic Vue web artifact with the public catalog assets."""

from __future__ import annotations

import gzip
import io
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
from typing import NoReturn

ROOT = Path(__file__).resolve().parents[1]
WEB_DIST = ROOT / "apps" / "web" / "dist"
PUBLIC = ROOT / "public"
ID = r"(?:case-\d+|framework-\d{3})"
WEB_ALLOWED = (
    re.compile(r"^index\.html$"),
    re.compile(r"^assets/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:css|js)$"),
)
CATALOG_ALLOWED = (
    re.compile(r"^data/(?:catalog\.json|stats\.json)$"),
    re.compile(rf"^data/prompts/{ID}\.txt$"),
    re.compile(rf"^data/generated-previews/{ID}\.prompt\.txt$"),
    re.compile(rf"^previews/{ID}\.webp$"),
)
SECRET = re.compile(
    rb"BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|"
    rb"OIDC_CLIENT_SECRET=|SESSION_SECRET=|PROVIDER_API_KEY=|"
    rb"sk-[A-Za-z0-9]{20,}"
)
LICENSES = (
    (ROOT / "NOTICE.md", "NOTICE.md"),
    (ROOT / "LICENSE", "LICENSE"),
    (ROOT / "third_party" / "animejs-LICENSE", "third_party/animejs-LICENSE"),
    (
        ROOT / "third_party" / "awesome-gpt-image-2-LICENSE",
        "third_party/awesome-gpt-image-2-LICENSE",
    ),
)


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def collect_tree(
    root: Path,
    patterns: tuple[re.Pattern[str], ...],
    *,
    prefix: str = "",
) -> list[tuple[Path, str]]:
    files: list[tuple[Path, str]] = []
    if not root.is_dir():
        fail(f"Artifact source directory is missing: {root}")
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            fail(f"Symlink is not allowed in web artifact: {path}")
        if path.is_dir():
            continue
        if not path.is_file():
            fail(f"Non-regular web artifact entry is not allowed: {path}")
        relative = PurePosixPath(prefix, path.relative_to(root).as_posix()).as_posix()
        if not any(pattern.fullmatch(relative) for pattern in patterns):
            fail(f"Web artifact path is not allowlisted: {relative}")
        data = path.read_bytes()
        if path.suffix.lower() in {".html", ".js", ".css", ".json", ".txt"} and SECRET.search(data):
            fail(f"Credential-like content found in web artifact file: {relative}")
        files.append((path, relative))
    return files


def artifact_files() -> list[tuple[Path, str]]:
    files = collect_tree(WEB_DIST, WEB_ALLOWED)
    files.extend(collect_tree(PUBLIC / "data", CATALOG_ALLOWED, prefix="data"))
    files.extend(collect_tree(PUBLIC / "previews", CATALOG_ALLOWED, prefix="previews"))
    names = [name for _, name in files]
    if len(names) != len(set(names)):
        fail("Duplicate path found in web artifact inputs")
    if "index.html" not in names:
        fail("Vue web artifact is missing index.html")
    if not any(name.startswith("assets/") and name.endswith(".js") for name in names):
        fail("Vue web artifact is missing a JavaScript bundle")
    if not any(name.startswith("assets/") and name.endswith(".css") for name in names):
        fail("Vue web artifact is missing a CSS bundle")
    return files


def add_bytes(archive: tarfile.TarFile, name: str, data: bytes, mtime: int) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = mtime
    archive.addfile(info, fileobj=io.BytesIO(data))


def main() -> None:
    if len(sys.argv) != 2:
        fail("Usage: scripts/create_web_artifact.py /path/to/output.tar.gz.tmp")
    output = Path(sys.argv[1]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    files = artifact_files()
    mtime = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
    members = files + list(LICENSES)
    for source, name in members:
        if not source.is_file() or source.stat().st_size == 0:
            fail(f"Required artifact source is missing or empty: {source}")
        normalized = PurePosixPath(name)
        if normalized.is_absolute() or ".." in normalized.parts:
            fail(f"Unsafe archive member: {name}")
    with output.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=mtime) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for source, name in sorted(members, key=lambda item: item[1]):
                    add_bytes(archive, name, source.read_bytes(), mtime)
    print(f"Created deterministic Vue web artifact with {len(members)} files: {output}")


if __name__ == "__main__":
    main()

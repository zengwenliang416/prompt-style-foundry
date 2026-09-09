#!/usr/bin/env python3
from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"


class StaticRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Serve static files without traceback noise when browsers cancel lazy images."""

    def copyfile(self, source, outputfile) -> None:  # type: ignore[no-untyped-def]
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError):
            return


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve the OnePic Template Studio static app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()

    handler = functools.partial(StaticRequestHandler, directory=str(PUBLIC))
    with ReusableTCPServer((args.host, args.port), handler) as server:
        print(f"OnePic Template Studio: http://{args.host}:{args.port}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

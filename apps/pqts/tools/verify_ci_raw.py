#!/usr/bin/env python3
"""Verify GitHub raw CI workflow has expected multiline structure."""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


WORKFLOW_PATH = ".github/workflows/ci.yml"
REQUIRED_KEYS = ("name:", "on:", "jobs:")
MIN_NEWLINE_COUNT = 50


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", default=os.getenv("GITHUB_SHA"), help="Git commit SHA")
    parser.add_argument(
        "--repo",
        default=os.getenv("GITHUB_REPOSITORY", "jakerslam/pqts"),
        help="GitHub repository in owner/name format",
    )
    return parser.parse_args()


def fetch_raw_workflow(repo: str, sha: str) -> str:
    url = f"https://raw.githubusercontent.com/{repo}/{sha}/{WORKFLOW_PATH}"
    try:
        with urlopen(url, timeout=20) as response:  # noqa: S310 - fixed trusted URL host
            content = response.read().decode("utf-8")
    except HTTPError as exc:
        if exc.code != 404:
            raise RuntimeError(f"HTTP error fetching {url}: {exc.code}") from exc

        # GitHub raw occasionally returns 404 for workflow files by commit SHA.
        # Fall back to Contents API with the same SHA ref.
        api_url = f"https://api.github.com/repos/{repo}/contents/{WORKFLOW_PATH}?ref={sha}"
        req = Request(api_url, headers={"Accept": "application/vnd.github+json"})
        token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urlopen(req, timeout=20) as response:  # noqa: S310 - fixed trusted URL host
                payload = json.loads(response.read().decode("utf-8"))
                encoded = payload.get("content", "")
                if not encoded:
                    raise RuntimeError(f"Empty content from {api_url}")
                content = base64.b64decode(encoded).decode("utf-8")
        except HTTPError as api_exc:
            raise RuntimeError(
                f"HTTP error fetching {url} and API fallback {api_url}: {api_exc.code}"
            ) from api_exc
        except URLError as api_exc:
            raise RuntimeError(
                f"Network error fetching {url} and API fallback {api_url}: {api_exc.reason}"
            ) from api_exc
    except URLError as exc:
        raise RuntimeError(f"Network error fetching {url}: {exc.reason}") from exc

    if not content.strip():
        raise RuntimeError(f"Fetched empty workflow from {url}")

    return content


def verify(content: str) -> None:
    newline_count = content.count("\n")
    line_count = len(content.splitlines())
    if newline_count <= MIN_NEWLINE_COUNT:
        raise RuntimeError(
            f"Expected >{MIN_NEWLINE_COUNT} newline chars in raw CI YAML, got {newline_count}."
        )
    if line_count <= MIN_NEWLINE_COUNT:
        raise RuntimeError(
            f"Expected >{MIN_NEWLINE_COUNT} lines in raw CI YAML, got {line_count}."
        )

    missing = [key for key in REQUIRED_KEYS if key not in content]
    if missing:
        raise RuntimeError(f"Missing required workflow keys in raw CI YAML: {missing}")


def main() -> int:
    args = parse_args()
    if not args.sha:
        print("ERROR: --sha not provided and GITHUB_SHA is unset.", file=sys.stderr)
        return 2

    content = fetch_raw_workflow(repo=args.repo, sha=args.sha)
    verify(content)
    print(
        "PASS: raw CI workflow validation succeeded "
        f"(repo={args.repo}, sha={args.sha}, newlines={content.count(chr(10))}, "
        f"lines={len(content.splitlines())})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

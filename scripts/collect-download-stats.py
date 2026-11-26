#!/usr/bin/env python3
"""Collect cumulative GitHub Release download counts into a public JSON snapshot."""

from __future__ import annotations

import json
import os
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = "xpfyg/kurocat"
OUT = Path(__file__).resolve().parent.parent / "website" / "data" / "download-stats.json"
API = f"https://api.github.com/repos/{REPO}/releases?per_page=100&page={{page}}"

INSTALLER_PATTERNS = (
    (re.compile(r"-x64-setup\.exe$", re.I), "win"),
    (re.compile(r"-macos-universal\.dmg$", re.I), "mac"),
    (re.compile(r"-linux-(amd64|arm64)\.(deb|appimage)$", re.I), "linux"),
)
ALIAS_PREFIXES = (
    "KuroCat-x64-setup.exe",
    "KuroCat-macos-universal.",
    "KuroCat-linux-",
    "MiniCat-x64-setup.exe",
    "MiniCat-macos-universal.",
    "MiniCat-linux-",
)


def platform_of(name: str) -> str | None:
    if name.endswith(".sig") or name.startswith(ALIAS_PREFIXES):
        return None
    for pattern, platform in INSTALLER_PATTERNS:
        if pattern.search(name):
            return platform
    return None


def fetch_releases() -> list[dict]:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        raise SystemExit("GH_TOKEN is required")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kurocat-download-stats",
    }
    releases: list[dict] = []
    for page in range(1, 11):
        request = urllib.request.Request(API.format(page=page), headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            batch = json.load(response)
        if not batch:
            break
        releases.extend(batch)
        if len(batch) < 100:
            break
    return releases


def main() -> None:
    releases = [release for release in fetch_releases() if not release.get("draft")]
    releases.sort(key=lambda release: release.get("published_at") or "")

    totals = {"win": 0, "mac": 0, "linux": 0}
    release_stats = []
    for release in releases:
        downloads = 0
        for asset in release.get("assets") or []:
            platform = platform_of(asset.get("name", ""))
            if not platform:
                continue
            count = int(asset.get("download_count") or 0)
            totals[platform] += count
            downloads += count
        release_stats.append(
            {
                "tag": release.get("tag_name", ""),
                "date": (release.get("published_at") or "")[:10],
                "downloads": downloads,
            }
        )

    total = sum(totals.values())
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    history: list[dict] = []
    if OUT.exists():
        try:
            previous = json.loads(OUT.read_text(encoding="utf-8"))
            history = [
                entry
                for entry in previous.get("history", [])
                if isinstance(entry, dict) and entry.get("date") and isinstance(entry.get("total"), int)
            ]
        except (json.JSONDecodeError, OSError):
            history = []

    history = [entry for entry in history if entry["date"] != today]
    history.append({"date": today, "total": total})
    history.sort(key=lambda entry: entry["date"])
    history = history[-366:]

    payload = {
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total": total,
        "win": totals["win"],
        "mac": totals["mac"],
        "linux": totals["linux"],
        "releases": release_stats,
        "history": history,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"total={total} win={totals['win']} mac={totals['mac']} linux={totals['linux']}")


if __name__ == "__main__":
    main()

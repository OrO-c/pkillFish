#!/usr/bin/env python3
"""
从 GitHub Issue 收集 ml-false-positive 误判样本，追加到 ml/data/false-positives.jsonl。

只读取公开 Issue，不执行 Issue 内容，不自动修改黑名单。

用法：
  python ml/collect_false_positives.py --repo OrO-c/pkillFish

也可以用 GITHUB_TOKEN 环境变量提高 GitHub API 限额。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
META_RE = re.compile(r"<!--\s*pkillfish:ml-false-positive\s*([\s\S]*?)-->", re.I)
TEXT_RE = re.compile(r"###\s*评论原文\s*([\s\S]*?)(?:\n###\s|$)", re.I)
FENCE_RE = re.compile(r"(?:```|~~~)(?:text)?\s*\r?\n([\s\S]*?)\r?\n(?:```|~~~)", re.I)
MID_RE = re.compile(r"^[1-9]\d{0,18}$")


def log(message: str) -> None:
    print(message, file=sys.stderr)


def parse_meta(body: str) -> dict[str, str]:
    match = META_RE.search(body or "")
    if not match:
        return {}
    meta: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower()
        if re.fullmatch(r"[a-z][a-z0-9_]{0,30}", key):
            meta[key] = value.strip()
    return meta


def parse_text(body: str) -> str:
    section = TEXT_RE.search(body or "")
    if not section:
        return ""
    fenced = FENCE_RE.search(section.group(1))
    if fenced:
        return fenced.group(1).strip()
    return section.group(1).strip()


def fetch_issues(repo: str, label: str, token: str) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for page in range(1, 21):
        params = urllib.parse.urlencode(
            {"state": "all", "labels": label, "per_page": 100, "page": page}
        )
        url = f"https://api.github.com/repos/{repo}/issues?{params}"
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "pkillFish-fp-collector/0.1",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                batch = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            log(f"GitHub API 请求失败：{exc}")
            break
        if not isinstance(batch, list) or not batch:
            break
        issues.extend(item for item in batch if isinstance(item, dict) and "pull_request" not in item)
        if len(batch) < 100:
            break
    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description="收集 ml-false-positive Issue 为负样本")
    parser.add_argument("--repo", default="OrO-c/pkillFish")
    parser.add_argument("--label", default="ml-false-positive")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent / "data" / "false-positives.jsonl"))
    parser.add_argument("--weight", type=float, default=3.0, help="通过审核的误判样本权重，默认 3")
    args = parser.parse_args()

    existing: set[tuple[str, str]] = set()
    out_path = Path(args.out)
    if out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            existing.add((str(row.get("uid", "")), str(row.get("rpid", ""))))

    issues = fetch_issues(args.repo, args.label, os.environ.get("GITHUB_TOKEN", ""))
    rows: list[dict[str, Any]] = []
    for issue in issues:
        labels = {
            str(label.get("name"))
            for label in issue.get("labels", [])
            if isinstance(label, dict)
        }
        approved = (
            (issue.get("state") == "closed" and issue.get("state_reason") == "completed")
            or "ml-false-positive-accepted" in labels
        )
        if not approved:
            continue
        body = str(issue.get("body") or "")
        meta = parse_meta(body)
        uid = meta.get("uid") or meta.get("mid") or ""
        rpid = meta.get("rpid") or ""
        text = parse_text(body)
        if not MID_RE.match(uid) or not MID_RE.match(rpid) or not text:
            continue
        if (uid, rpid) in existing:
            continue
        existing.add((uid, rpid))
        rows.append(
            {
                "uid": uid,
                "rpid": rpid,
                "oid": "",
                "type": "",
                "text": text,
                "ctime": "",
                "uname": "",
                "source": "github-ml-false-positive",
                "issue": int(issue.get("number") or 0),
                "text_sha1": hashlib.sha1(text.encode("utf-8")).hexdigest(),
                "label": 0,
                "weight": max(0.1, min(20.0, float(args.weight))),
            }
        )

    if rows:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("a", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    log(f"发现 Issue {len(issues)} 个；新增负样本 {len(rows)} 条；输出 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

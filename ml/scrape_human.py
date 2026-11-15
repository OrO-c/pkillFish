#!/usr/bin/env python3
"""
从 B 站公开视频页面 DOM 采集正常评论，作为训练负样本。

这不是 B 站 API 调用：
  - 用 Playwright Firefox 打开公开视频页；
  - 通过 open Shadow DOM 读取页面已经渲染的评论；
  - 不登录、不提交任何内容、不调用 api.bilibili.com。

用途：
  - 黑名单账号在 2026-10 之后的评论作为正样本；
  - 这里采集的正常评论作为负样本，避免模型只学会“黑名单账号风格”。

用法：
  python ml/scrape_human.py --data ml/data/positives.jsonl --out ml/data/human.jsonl
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

from scrape_aicu import START_URL, api_page, normalize_reply

ROOT = Path(__file__).resolve().parents[1]
MID_RE = re.compile(r"^[1-9]\d{0,18}$")


def log(message: str) -> None:
    print(message, file=sys.stderr)


def clean(value: Any, limit: int = 2000) -> str:
    if not isinstance(value, str):
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    return text[:limit]


def load_blacklisted(path: Path) -> set[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out = {str(item) for item in data.get("revoked", [])}
    for entry in data.get("entries", []):
        mid = entry.get("mid") if isinstance(entry, dict) else entry
        if mid is not None:
            out.add(str(mid))
    return out


def load_video_ids(path: Path, limit: int) -> list[str]:
    if limit <= 0:
        return []
    ids: list[str] = []
    seen: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        oid = str(row.get("oid") or "")
        kind = str(row.get("type") or "")
        if kind == "1" and MID_RE.match(oid) and oid not in seen:
            seen.add(oid)
            ids.append(oid)
            if limit > 0 and len(ids) >= limit:
                break
    return ids


def append_jsonl(path: Path, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(rows)


def extract_from_page(page: Any, blacklisted: set[str], oid: str) -> list[dict[str, Any]]:
    data = page.evaluate(
        """({oid}) => {
          const out = [];
          const textOf = (el) => el && (el.innerText || el.textContent || '').trim();
          const host = document.querySelector('bili-comments');
          if (!host || !host.shadowRoot) return {error: 'no bili-comments', out};
          const feed = host.shadowRoot.querySelector('#feed');
          if (!feed) return {error: 'no feed', out};

          const read = (renderer, kind) => {
            if (!renderer) return;
            const data = renderer.__data || {};
            const shadow = renderer.shadowRoot;
            if (!shadow) return;
            const avatar = shadow.querySelector('#user-avatar');
            const unameEl = shadow.querySelector('bili-comment-user-info');
            const userName = unameEl && unameEl.shadowRoot
              ? unameEl.shadowRoot.querySelector('#user-name')
              : null;
            const rich = shadow.querySelector('bili-rich-text');
            const contents = rich && rich.shadowRoot ? rich.shadowRoot.querySelector('#contents') : null;
            const mid = String(
              (avatar && avatar.getAttribute('data-user-profile-id')) ||
              (userName && userName.getAttribute('data-user-profile-id')) ||
              data.mid || ''
            );
            const text = (data.content && data.content.message) || textOf(contents);
            const rpid = String(data.rpid || renderer.getAttribute('data-rpid') || '');
            const uname = (data.member && data.member.uname) || textOf(userName);
            if (mid && text && rpid) out.push({mid, rpid, uname, text, kind});
          };

          for (const thread of feed.querySelectorAll('bili-comment-thread-renderer')) {
            const threadShadow = thread.shadowRoot;
            if (!threadShadow) continue;
            const root = threadShadow.querySelector('bili-comment-renderer');
            read(root, 'root');
            const replies = threadShadow.querySelector('bili-comment-replies-renderer');
            if (replies && replies.shadowRoot) {
              for (const reply of replies.shadowRoot.querySelectorAll('bili-comment-reply-renderer')) {
                read(reply, 'reply');
              }
            }
          }
          return {error: '', out};
        }""",
        {"oid": oid},
    )
    if not isinstance(data, dict):
        return []
    rows: list[dict[str, Any]] = []
    for item in data.get("out") or []:
        if not isinstance(item, dict):
            continue
        mid = str(item.get("mid") or "")
        text = clean(item.get("text"))
        rpid = str(item.get("rpid") or "")
        if not MID_RE.match(mid) or mid in blacklisted or not text or not rpid:
            continue
        rows.append(
            {
                "uid": mid,
                "rpid": rpid,
                "oid": oid,
                "type": "1",
                "text": text,
                "ctime": "",
                "uname": clean(item.get("uname"), 80),
                "source": "bilibili-dom",
                "text_sha1": hashlib.sha1(text.encode("utf-8")).hexdigest(),
                "label": 0,
            }
        )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 B 站公开页面评论作为负样本")
    parser.add_argument("--data", default=str(Path(__file__).resolve().parent / "data" / "positives.jsonl"))
    parser.add_argument("--blacklist", default=str(ROOT / "blacklist.json"))
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent / "data" / "human.jsonl"))
    parser.add_argument("--videos", type=int, default=8)
    parser.add_argument("--scrolls", type=int, default=6)
    parser.add_argument("--headful", action="store_true")
    parser.add_argument("--aicu-hot", action="store_true", help="从 aicu 热搜 UID 采集正常评论")
    parser.add_argument("--hot-users", type=int, default=10)
    parser.add_argument("--hot-pages", type=int, default=2)
    parser.add_argument("--timeout-ms", type=int, default=60000)
    args = parser.parse_args()

    blacklisted = load_blacklisted(Path(args.blacklist))
    videos = load_video_ids(Path(args.data), args.videos)
    if not videos and not args.aicu_hot:
        log("没有从正样本中找到视频 oid")
        return 2

    existing: set[tuple[str, str, str]] = set()
    out_path = Path(args.out)
    if out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            existing.add((str(row.get("uid", "")), str(row.get("rpid", "")), str(row.get("text_sha1", ""))))

    from playwright.sync_api import sync_playwright

    total = 0
    with sync_playwright() as playwright:
        browser = playwright.firefox.launch(headless=not args.headful)
        context = browser.new_context(locale="zh-CN", viewport={"width": 1366, "height": 900})
        page = context.new_page()
        for index, oid in enumerate(videos, 1):
            url = f"https://www.bilibili.com/video/av{oid}"
            log(f"[{index}/{len(videos)}] {url}")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=args.timeout_ms)
                page.wait_for_timeout(5000)
                for _ in range(max(1, args.scrolls)):
                    page.mouse.wheel(0, 1800)
                    page.wait_for_timeout(900)
                rows = extract_from_page(page, blacklisted, oid)
            except Exception as exc:
                log(f"  失败：{exc}")
                continue

            fresh: list[dict[str, Any]] = []
            for row in rows:
                key = (row["uid"], row["rpid"], row["text_sha1"])
                if key in existing:
                    continue
                existing.add(key)
                fresh.append(row)
            total += append_jsonl(out_path, fresh)
            log(f"  新增正常评论 {len(fresh)} 条")
            time.sleep(2)

        if args.aicu_hot:
            log("采集 aicu 热搜 UID 的公开评论作为正常样本")
            try:
                page.goto(START_URL, wait_until="domcontentloaded", timeout=args.timeout_ms)
                page.wait_for_timeout(1500)
                hot = page.evaluate(
                    """async ({limit}) => {
                      const r = await fetch('https://online.aicu.cc/api/community/trending?limit=' + limit, {
                        headers: {'Accept': 'application/json'}
                      }).then(x => x.json());
                      return (r && r.data && r.data.hot_searches) || [];
                    }""",
                    {"limit": args.hot_users},
                )
            except Exception as exc:
                log(f"  热搜列表失败：{exc}")
                hot = []
            for index, item in enumerate(hot, 1):
                uid = str((item or {}).get("uid") or "")
                if not MID_RE.match(uid) or uid in blacklisted:
                    continue
                log(f"  [{index}/{len(hot)}] 热搜 UID {uid}")
                for pn in range(1, max(1, args.hot_pages) + 1):
                    payload = api_page(page, uid, pn, pn == 1)
                    reply = payload.get("reply") or {}
                    if reply.get("code") != 0 or not isinstance(reply.get("data"), dict):
                        break
                    replies = reply["data"].get("replies") or []
                    page_rows = []
                    for item2 in replies:
                        if not isinstance(item2, dict):
                            continue
                        row = normalize_reply(item2, uid)
                        if not row or row["uid"] in blacklisted:
                            continue
                        row["label"] = 0
                        page_rows.append(row)
                    fresh = []
                    for row in page_rows:
                        key = (row["uid"], row["rpid"], row["text_sha1"])
                        if key in existing:
                            continue
                        existing.add(key)
                        fresh.append(row)
                    total += append_jsonl(out_path, fresh)
                    log(f"    第 {pn} 页：新增 {len(fresh)} 条")
                    if reply["data"].get("cursor", {}).get("is_end") or not fresh:
                        break
                    time.sleep(1.5)
                time.sleep(1.5)
        context.close()
        browser.close()

    log(f"完成：新增负样本 {total} 条；输出 {out_path}")
    return 0 if total else 1


if __name__ == "__main__":
    raise SystemExit(main())

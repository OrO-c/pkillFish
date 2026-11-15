#!/usr/bin/env python3
"""
从指定 BV 号的 B 站公开视频页采集正常评论，作为同领域硬负样本。

特点：
  - 支持使用已有 Firefox 用户数据（--profile-dir，或自动探测默认 profile）；
  - 只需要给 BV 号；
  - 读取公开页面 DOM，不调用 api.bilibili.com；
  - 排除当前 blacklist.json / revoked 中的 UID；
  - 输出 ml/data/same-video.jsonl，label=0，weight=2；
  - 记录 video / oid / thread，供训练按视频分组切分。

用法：
  python ml/scrape_video.py --bv BV1xxxxxxxxx
  python ml/scrape_video.py --bv BV1xxxxxxxxx --profile-dir ~/.mozilla/firefox/xxxx.default-release --headful
"""

from __future__ import annotations

import argparse
import configparser
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BV_RE = re.compile(r"BV[0-9A-Za-z]{10}")


def log(message: str) -> None:
    print(message, file=sys.stderr)


def clean(value: Any, limit: int = 2000) -> str:
    if not isinstance(value, str):
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    return text[:limit]


def parse_bv(value: str) -> str:
    match = BV_RE.search(str(value or ""))
    return match.group(0) if match else ""


def detect_firefox_profile() -> Path | None:
    base = Path.home() / ".mozilla" / "firefox"
    ini = base / "profiles.ini"
    if not ini.exists():
        return None
    parser = configparser.ConfigParser()
    try:
        parser.read(ini)
    except Exception:
        return None
    fallback = None
    for section in parser.sections():
        if not section.startswith("Profile"):
            continue
        path = parser.get(section, "Path", fallback="")
        if not path:
            continue
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = base / candidate
        if fallback is None:
            fallback = candidate
        if parser.get(section, "Default", fallback="0") == "1":
            return candidate
    return fallback


def load_blacklisted(path: Path) -> set[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out = {str(item) for item in data.get("revoked", [])}
    for entry in data.get("entries", []):
        mid = entry.get("mid") if isinstance(entry, dict) else entry
        if mid is not None:
            out.add(str(mid))
    return out


def append_jsonl(path: Path, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(rows)


def existing_keys(path: Path) -> set[tuple[str, str, str]]:
    keys: set[tuple[str, str, str]] = set()
    if not path.exists():
        return keys
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        keys.add((str(row.get("uid", "")), str(row.get("rpid", "")), str(row.get("text_sha1", ""))))
    return keys


def get_video_oid(page: Any) -> str:
    try:
        value = page.evaluate(
            """() => {
              const s = window.__INITIAL_STATE__ || {};
              return String(s.aid || (s.videoData && s.videoData.aid) || '');
            }"""
        )
        return re.sub(r"\D", "", str(value or ""))
    except Exception:
        return ""


def extract_comments(page: Any, bv: str, oid: str, blacklisted: set[str]) -> list[dict[str, Any]]:
    data = page.evaluate(
        """({bv, oid}) => {
          const out = [];
          const textOf = (el) => el && (el.innerText || el.textContent || '').trim();
          const host = document.querySelector('bili-comments');
          if (!host || !host.shadowRoot) return {error: 'no bili-comments', out};
          const feed = host.shadowRoot.querySelector('#feed');
          if (!feed) return {error: 'no feed', out};

          const read = (renderer, threadRpid, kind) => {
            if (!renderer || !renderer.shadowRoot) return;
            const sh = renderer.shadowRoot;
            const data = renderer.__data || {};
            const avatar = sh.querySelector('#user-avatar');
            const userInfo = sh.querySelector('bili-comment-user-info');
            const nameNode = userInfo && userInfo.shadowRoot
              ? userInfo.shadowRoot.querySelector('#user-name')
              : null;
            const rich = sh.querySelector('bili-rich-text');
            const contents = rich && rich.shadowRoot ? rich.shadowRoot.querySelector('#contents') : null;
            const mid = String(
              (avatar && avatar.getAttribute('data-user-profile-id')) ||
              (nameNode && nameNode.getAttribute('data-user-profile-id')) ||
              data.mid || ''
            );
            const rpid = String(data.rpid || renderer.getAttribute('data-rpid') || '');
            const text = (data.content && data.content.message) || textOf(contents);
            const uname = (data.member && data.member.uname) || textOf(nameNode);
            const parent = data.parent && (data.parent.parentid || data.parent.rootid);
            if (mid && rpid && text) {
              out.push({mid, rpid, uname, text, kind, thread: threadRpid || rpid, parent: String(parent || '')});
            }
          };

          for (const thread of feed.querySelectorAll('bili-comment-thread-renderer')) {
            const ts = thread.shadowRoot;
            if (!ts) continue;
            const root = ts.querySelector('bili-comment-renderer');
            if (!root) continue;
            const rootData = root.__data || {};
            const rootRpid = String(rootData.rpid || '');
            read(root, rootRpid, 'root');
            const replies = ts.querySelector('bili-comment-replies-renderer');
            if (replies && replies.shadowRoot) {
              for (const reply of replies.shadowRoot.querySelectorAll('bili-comment-reply-renderer')) {
                read(reply, rootRpid, 'reply');
              }
            }
          }
          return {error: '', bv, oid, out};
        }""",
        {"bv": bv, "oid": oid},
    )
    if not isinstance(data, dict):
        return []
    rows: list[dict[str, Any]] = []
    for item in data.get("out") or []:
        if not isinstance(item, dict):
            continue
        uid = str(item.get("mid") or "")
        rpid = str(item.get("rpid") or "")
        text = clean(item.get("text"))
        if not re.fullmatch(r"[1-9]\d{0,18}", uid) or uid in blacklisted:
            continue
        if not re.fullmatch(r"[1-9]\d{0,18}", rpid) or not text:
            continue
        rows.append(
            {
                "uid": uid,
                "rpid": rpid,
                "oid": oid,
                "video": bv,
                "thread": str(item.get("thread") or ""),
                "parent": str(item.get("parent") or ""),
                "text": text,
                "ctime": "",
                "uname": clean(item.get("uname"), 80),
                "source": "bilibili-video-dom",
                "text_sha1": hashlib.sha1(text.encode("utf-8")).hexdigest(),
                "label": 0,
                "weight": 2.0,
            }
        )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="从 BV 视频采集同领域正常评论")
    parser.add_argument("--bv", action="append", required=True, help="BV 号或完整视频 URL，可重复/逗号分隔")
    parser.add_argument("--profile-dir", default="", help="Firefox 用户数据目录；留空自动探测默认 profile")
    parser.add_argument("--no-profile", action="store_true", help="不使用已有 Firefox 数据")
    parser.add_argument("--blacklist", default=str(ROOT / "blacklist.json"))
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent / "data" / "same-video.jsonl"))
    parser.add_argument("--headful", action="store_true")
    parser.add_argument("--scrolls", type=int, default=8)
    parser.add_argument("--timeout-ms", type=int, default=60000)
    args = parser.parse_args()

    bvs: list[str] = []
    for value in args.bv:
        for part in str(value).replace(",", " ").split():
            bv = parse_bv(part)
            if bv and bv not in bvs:
                bvs.append(bv)
    if not bvs:
        log("没有有效 BV 号")
        return 2

    profile = None
    if not args.no_profile:
        profile = Path(args.profile_dir).expanduser() if args.profile_dir else detect_firefox_profile()
    if profile:
        log(f"使用 Firefox 用户数据：{profile}")
        if not profile.exists():
            log("profile 不存在；请检查 --profile-dir")
            return 2
    else:
        log("未找到 Firefox 用户数据，使用临时浏览器上下文（可能未登录）")

    blacklisted = load_blacklisted(Path(args.blacklist))
    out_path = Path(args.out)
    existing = existing_keys(out_path)

    from playwright.sync_api import sync_playwright

    total = 0
    with sync_playwright() as playwright:
        context = None
        browser = None
        if profile:
            context = playwright.firefox.launch_persistent_context(
                user_data_dir=str(profile),
                headless=not args.headful,
                locale="zh-CN",
                viewport={"width": 1366, "height": 900},
            )
            page = context.pages[0] if context.pages else context.new_page()
        else:
            browser = playwright.firefox.launch(headless=not args.headful)
            context = browser.new_context(locale="zh-CN", viewport={"width": 1366, "height": 900})
            page = context.new_page()

        for index, bv in enumerate(bvs, 1):
            url = f"https://www.bilibili.com/video/{bv}"
            log(f"[{index}/{len(bvs)}] {url}")
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=args.timeout_ms)
                page.wait_for_timeout(5000)
                oid = get_video_oid(page)
                for _ in range(max(1, args.scrolls)):
                    page.mouse.wheel(0, 1600)
                    page.wait_for_timeout(900)
                rows = extract_comments(page, bv, oid, blacklisted)
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
            log(f"  新增同视频正常评论 {len(fresh)} 条（oid={oid or '未知'}）")
            time.sleep(2)

        context.close()
        if browser:
            browser.close()

    log(f"完成：新增同视频负样本 {total} 条；输出 {out_path}")
    return 0 if total else 1


if __name__ == "__main__":
    raise SystemExit(main())

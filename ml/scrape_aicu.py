#!/usr/bin/env python3
"""
采集 aicu.cc 的公开历史评论，生成 pkillFish 训练样本。

数据来源是 aicu.cc 在浏览器中使用的公开查询接口：
  1. GET https://api.aicu.cc/api/v4/queue/enqueue
  2. GET https://api.aicu.cc/api/v4/search/getreply
       ?uid=<uid>&pn=<page>&ps=100&keyword=&mode=0
       &need_count=true|false&ticket=<ticket>

注意：
  - 每次 getreply 前都要重新 enqueue 获取 ticket；ticket 是一次性的。
  - 本脚本不登录、不提交 Cookie，只读取公开评论。
  - 黑名单账号在 2026-10-01（Asia/Shanghai）之后发布的评论，不论内容，
    全部作为正样本（label=1）。
  - 默认不采集 2026-10 之前的评论；如果确实需要负样本，可显式
    使用 --include-before-as-negatives。这些是同一账号人类使用时期的评论，
    适合做 hard negative，但会额外采集旧数据。

依赖只有 Playwright 的 Firefox 和训练脚本需要的 sklearn/numpy/scipy，
不使用任何来源不明的 aicu 第三方包。

用法：
  python -m playwright install firefox
  python ml/scrape_aicu.py \
      --blacklist blacklist.json \
      --out ml/data \
      --headful
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("Asia/Shanghai")
DEFAULT_SINCE = "2026-10-01"
START_URL = "https://www.aicu.cc/"
API_ENQUEUE = "https://api.aicu.cc/api/v4/queue/enqueue"
API_GETREPLY = "https://api.aicu.cc/api/v4/search/getreply"


def log(message: str) -> None:
    print(message, file=sys.stderr)


def clean_text(value: Any, limit: int = 4000) -> str:
    if not isinstance(value, str):
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text[:limit]


def normalize_mid(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text if re.fullmatch(r"[1-9]\d{0,18}", text) else ""


def parse_time(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if number > 10_000_000_000:
            number /= 1000.0
        try:
            return datetime.fromtimestamp(number, tz=TZ)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if re.fullmatch(r"\d{10,13}", text):
            return parse_time(int(text))
        text = text.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=TZ)
            return parsed.astimezone(TZ)
        except ValueError:
            return None
    return None


def load_uids(path: Path, extra: list[str], limit: int) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    revoked = {str(item) for item in data.get("revoked", [])}
    uids: list[str] = []
    for entry in data.get("entries", []):
        mid = normalize_mid(entry.get("mid") if isinstance(entry, dict) else entry)
        if mid and mid not in revoked and mid not in uids:
            uids.append(mid)
    for value in extra:
        mid = normalize_mid(value)
        if mid and mid not in uids:
            uids.append(mid)
    return uids[:limit] if limit > 0 else uids


def existing_keys(path: Path) -> set[tuple[str, str, str]]:
    keys: set[tuple[str, str, str]] = set()
    if not path.exists():
        return keys
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        keys.add(
            (
                str(row.get("uid", "")),
                str(row.get("rpid", "")),
                str(row.get("text_sha1", "")),
            )
        )
    return keys


def append_jsonl(path: Path, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(rows)


def normalize_reply(reply: dict[str, Any], uid: str) -> dict[str, Any] | None:
    text = clean_text(reply.get("message"))
    rpid = normalize_mid(reply.get("rpid"))
    created = parse_time(reply.get("time"))
    if not text or not rpid or not created:
        return None
    dyn = reply.get("dyn") if isinstance(reply.get("dyn"), dict) else {}
    return {
        "uid": uid,
        "rpid": rpid,
        "oid": normalize_mid(dyn.get("oid")),
        "type": normalize_mid(dyn.get("type")),
        "text": text,
        "ctime": created.isoformat(),
        "uname": "",
        "parent": reply.get("parent") if isinstance(reply.get("parent"), dict) else {},
        "source": "aicu",
        "text_sha1": hashlib.sha1(text.encode("utf-8")).hexdigest(),
    }


def api_page(page: Any, uid: str, page_number: int, need_count: bool) -> dict[str, Any]:
    """在 aicu 同源页面里调用公开接口；返回原始 JSON。"""
    result = page.evaluate(
        """async ({uid, pn, needCount}) => {
          const enqueue = await fetch('https://api.aicu.cc/api/v4/queue/enqueue', {
            credentials: 'include',
            headers: {'Accept': 'application/json'}
          }).then(r => r.json());
          if (!enqueue || enqueue.code !== 0 || !enqueue.data || !enqueue.data.ticket) {
            return {stage: 'enqueue', enqueue};
          }
          const params = new URLSearchParams({
            uid: String(uid),
            pn: String(pn),
            ps: '100',
            keyword: '',
            mode: '0',
            need_count: needCount ? 'true' : 'false',
            ticket: enqueue.data.ticket
          });
          const reply = await fetch('https://api.aicu.cc/api/v4/search/getreply?' + params.toString(), {
            credentials: 'include',
            headers: {'Accept': 'application/json'}
          }).then(r => r.json());
          return {stage: 'getreply', enqueue, reply};
        }""",
        {"uid": uid, "pn": page_number, "needCount": need_count},
    )
    return result if isinstance(result, dict) else {}


def main() -> int:
    parser = argparse.ArgumentParser(description="采集 aicu.cc 公开历史评论")
    parser.add_argument("--blacklist", default=str(ROOT / "blacklist.json"))
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent / "data"))
    parser.add_argument("--uid", action="append", default=[], help="额外 UID，可重复")
    parser.add_argument("--limit", type=int, default=0, help="最多处理多少个 UID")
    parser.add_argument("--since", default=DEFAULT_SINCE)
    parser.add_argument("--include-before-as-negatives", action="store_true")
    parser.add_argument(
        "--negative-pages",
        type=int,
        default=2,
        help="在 2026-10 边界之后额外抓多少页作为负样本；0 表示不额外抓旧页",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=0,
        help="最多抓多少页；0 表示一直抓到接口结束或早于 since",
    )
    parser.add_argument("--delay", type=float, default=2.5)
    parser.add_argument("--headful", action="store_true")
    parser.add_argument("--timeout-ms", type=int, default=60000)
    args = parser.parse_args()

    since = datetime.fromisoformat(args.since).replace(tzinfo=TZ)
    out_dir = Path(args.out)
    positives_path = out_dir / "positives.jsonl"
    negatives_path = out_dir / "negatives.jsonl"
    uids = load_uids(Path(args.blacklist), args.uid, args.limit)
    if not uids:
        log("没有可处理的 UID")
        return 2

    log(f"目标 UID：{len(uids)} 个；正样本起点：{since.date()}")
    positive_keys = existing_keys(positives_path)
    negative_keys = existing_keys(negatives_path)
    total_pos = 0
    total_neg = 0

    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.firefox.launch(headless=not args.headful)
        context = browser.new_context(locale="zh-CN", viewport={"width": 1366, "height": 900})
        page = context.new_page()
        page.goto(START_URL, wait_until="domcontentloaded", timeout=args.timeout_ms)
        page.wait_for_timeout(2000)

        for index, uid in enumerate(uids, 1):
            log(f"[{index}/{len(uids)}] UID {uid}")
            raw_dir = out_dir / "raw" / uid
            raw_dir.mkdir(parents=True, exist_ok=True)
            comments: list[dict[str, Any]] = []

            page_number = 1
            pre_cutoff_pages = 0
            while True:
                if args.max_pages > 0 and page_number > args.max_pages:
                    break
                payload: dict[str, Any] = {}
                for attempt in range(3):
                    try:
                        payload = api_page(page, uid, page_number, page_number == 1)
                    except Exception as exc:
                        log(f"  第 {page_number} 页请求失败（{attempt + 1}/3）：{exc}")
                        time.sleep(1.5)
                        continue
                    if payload.get("stage") == "getreply":
                        reply = payload.get("reply") or {}
                        if reply.get("code") == 0:
                            break
                        log(f"  第 {page_number} 页返回 code={reply.get('code')}，重试 ticket")
                    time.sleep(1.2)

                reply = payload.get("reply") or {}
                if reply.get("code") != 0 or not isinstance(reply.get("data"), dict):
                    log(f"  第 {page_number} 页无数据，停止该 UID")
                    break

                (raw_dir / f"page-{page_number:03d}.json").write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                replies = reply["data"].get("replies") or []
                if not isinstance(replies, list) or not replies:
                    break

                page_rows: list[dict[str, Any]] = []
                for item in replies:
                    if not isinstance(item, dict):
                        continue
                    row = normalize_reply(item, uid)
                    if row:
                        created = parse_time(row["ctime"])
                        row["label"] = 1 if created and created >= since else 0
                        page_rows.append(row)
                        comments.append(row)

                cursor = reply["data"].get("cursor") or {}
                if cursor.get("is_end"):
                    break
                oldest = min((parse_time(row["ctime"]) for row in page_rows if row), default=None) if page_rows else None
                if oldest and oldest < since:
                    if not args.include_before_as_negatives or args.negative_pages <= 0:
                        break
                    pre_cutoff_pages += 1
                    if pre_cutoff_pages >= args.negative_pages:
                        break
                time.sleep(args.delay)
                page_number += 1

            positives: list[dict[str, Any]] = []
            negatives: list[dict[str, Any]] = []
            for row in sorted(comments, key=lambda item: item["ctime"]):
                created = parse_time(row["ctime"])
                if created is None:
                    continue
                key = (row["uid"], row["rpid"], row["text_sha1"])
                if created >= since:
                    if key not in positive_keys:
                        row["label"] = 1
                        positives.append(row)
                        positive_keys.add(key)
                elif (
                    args.include_before_as_negatives
                    and args.negative_pages > 0
                    and key not in negative_keys
                ):
                    row["label"] = 0
                    negatives.append(row)
                    negative_keys.add(key)

            total_pos += append_jsonl(positives_path, positives)
            total_neg += append_jsonl(negatives_path, negatives)
            log(f"  新增正样本 {len(positives)} 条" + (f"；负样本 {len(negatives)} 条" if args.include_before_as_negatives else ""))
            time.sleep(args.delay)

        context.close()
        browser.close()

    log(f"完成：正样本 {total_pos} 条，负样本 {total_neg} 条")
    log(f"输出：{positives_path}")
    if args.include_before_as_negatives:
        log(f"负样本：{negatives_path}")
    if total_pos == 0 and total_neg == 0:
        log("没有提取到评论。可加 --headful 查看 aicu 是否触发了人机验证。")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

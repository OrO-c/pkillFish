#!/usr/bin/env python3
"""
训练 pkillFish 的轻量文本分类模型，并导出浏览器可加载的 model.json。

模型：
  - NFKC / 小写 / URL 与 @ 规范化
  - 字符 1-4 gram，FNV-1a 哈希到固定桶
  - 少量风格特征
  - L2 逻辑回归
  - int8 权重量化，JS 端直接做点积

用法：
  python ml/train_model.py --data ml/data --out ml/artifacts/model.json
  python ml/train_model.py --data ml/data --negatives ml/data/human.jsonl \
      --target-precision 0.95

数据：
  JSONL，每行至少包含 text、uid；label 为 1/0，
  也可以分别放在 positives.jsonl / negatives.jsonl 中由文件名推断。
  正样本建议只使用 2026-10 之后的评论。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GroupShuffleSplit

FORMAT = "pkillfish-ml-v1"
FEATURE_VERSION = 1
ROOT = Path(__file__).resolve().parents[1]
URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
MENTION_RE = re.compile(r"@[A-Za-z0-9_\-\u4e00-\u9fff]+")
# 不让“模型名称”本身成为分类捷径；名称统一成 <model>，保留句式/风格特征。
MODEL_TERM_RE = re.compile(
    r"(?<![a-z0-9])(?:"
    r"deepseek(?:\s*harness)?|dsh(?:-agent)?|openai|chatgpt|"
    r"gpt(?:-?\d+(?:\.\d+)?)?(?:-?o)?|claude|gemini|qwen|llama|"
    r"mistral|glm|chatglm|kimi|moonshot|minimax|anthropic|"
    r"ai|agent|o[13](?![a-z0-9])"
    r")(?![a-z0-9])"
    r"|大模型|生成式模型|人工智能|智能体|模型|通义千问|文心一言|豆包|混元|星火|百川",
    re.IGNORECASE,
)
WS_RE = re.compile(r"\s+")
CTRL_RE = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")
EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002700-\U000027BF\U0001F1E6-\U0001F1FF]"
)
BULLET_RE = re.compile(r"(^|\n)\s*(?:[-*•]|\d+[.、)])\s+")
REPEAT_PUNCT_RE = re.compile(r"[!?！？]{2,}|[。.]{3,}")


def log(message: str) -> None:
    print(message, file=sys.stderr)


def normalize_text(value: Any) -> str:
    text = str(value or "")
    text = unicodedata.normalize("NFKC", text).lower()
    text = CTRL_RE.sub("", text)
    text = URL_RE.sub(" <url> ", text)
    text = MENTION_RE.sub(" <mention> ", text)
    text = MODEL_TERM_RE.sub(" ", text)
    text = WS_RE.sub(" ", text).strip()
    return text[:4000]


def fnv1a32(text: str) -> int:
    value = 2166136261
    for byte in text.encode("utf-8"):
        value ^= byte
        value = (value * 16777619) & 0xFFFFFFFF
    return value


def length_bucket(length: int) -> str:
    if length <= 20:
        return "len_0_20"
    if length <= 50:
        return "len_21_50"
    if length <= 100:
        return "len_51_100"
    if length <= 300:
        return "len_101_300"
    return "len_301_plus"


def feature_tokens(text: str, ngram_min: int, ngram_max: int) -> list[str]:
    normalized = normalize_text(text)
    if not normalized:
        return []

    chars = list("^" + normalized + "$")
    tokens: list[str] = []
    for n in range(ngram_min, ngram_max + 1):
        for index in range(0, len(chars) - n + 1):
            gram = "".join(chars[index : index + n])
            if not gram.strip():
                continue
            tokens.append("g:" + gram)

    tokens.extend(
        [
            "f:" + length_bucket(len(normalized)),
            "f:has_url" if "<url>" in normalized else "f:no_url",
            "f:has_mention" if "<mention>" in normalized else "f:no_mention",
            "f:has_emoji" if EMOJI_RE.search(normalized) else "f:no_emoji",
            "f:has_bullet" if BULLET_RE.search(normalized) else "f:no_bullet",
            "f:has_question" if ("?" in normalized or "？" in normalized) else "f:no_question",
            "f:has_repeat_punct" if REPEAT_PUNCT_RE.search(normalized) else "f:no_repeat_punct",
            "f:has_exclaim" if ("!" in normalized or "！" in normalized) else "f:no_exclaim",
        ]
    )
    return tokens


def hashed_features(text: str, spec: dict[str, Any]) -> set[int]:
    buckets = int(spec["buckets"])
    result: set[int] = set()
    for token in feature_tokens(text, int(spec["ngramMin"]), int(spec["ngramMax"])):
        result.add(fnv1a32(token) % buckets)
    return result


def load_rows(paths: Iterable[Path], include_precut: bool = False) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        if not path.exists():
            continue
        if path.is_dir():
            files = [
                file
                for file in sorted(path.rglob("*.jsonl"))
                if include_precut or file.name != "negatives.jsonl"
            ]
        else:
            files = [path]
        for file in files:
            for line_number, line in enumerate(file.read_text(encoding="utf-8").splitlines(), 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    log(f"跳过无效 JSON：{file}:{line_number}")
                    continue
                if not isinstance(row, dict):
                    continue
                text = str(row.get("text") or row.get("message") or "").strip()
                uid = str(row.get("uid") or row.get("mid") or "").strip()
                if not text or not uid:
                    continue
                label = row.get("label")
                if label not in (0, 1, "0", "1", False, True):
                    if "negative" in file.name.lower():
                        label = 0
                    elif "positive" in file.name.lower():
                        label = 1
                    else:
                        log(f"跳过没有 label 的样本：{file}:{line_number}")
                        continue
                label = int(label)
                if label not in (0, 1):
                    continue
                try:
                    weight = float(row.get("weight", 1.0))
                except (TypeError, ValueError):
                    weight = 1.0
                weight = max(0.1, min(20.0, weight))
                source = str(row.get("source") or "")
                rows.append(
                    {
                        "text": text,
                        "uid": uid,
                        "label": label,
                        "weight": weight,
                        "must_train": weight > 1.0 or source == "github-ml-false-positive",
                        "ctime": str(row.get("ctime") or ""),
                        "uname": str(row.get("uname") or ""),
                    }
                )
    return rows


def dedupe_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_text: dict[str, dict[str, Any]] = {}
    conflicts = 0
    for row in rows:
        key = normalize_text(row["text"])
        if not key:
            continue
        existing = by_text.get(key)
        if existing is None:
            by_text[key] = row
        elif existing["label"] == row["label"]:
            existing["weight"] = max(float(existing.get("weight", 1.0)), float(row.get("weight", 1.0)))
        elif existing["label"] != row["label"]:
            # 相同文本出现冲突标签：丢弃，避免把模棱两可的模板喂给模型。
            conflicts += 1
            del by_text[key]
    if conflicts:
        log(f"丢弃 {conflicts} 组同文不同标签的样本")
    return list(by_text.values())


def split_groups(rows: list[dict[str, Any]], seed: int) -> tuple[list[dict], list[dict], list[dict], dict]:
    groups = sorted({row["uid"] for row in rows})
    if len(groups) < 3:
        log("UID 分组少于 3 个，无法做严格分组切分；改用随机切分，指标可能偏乐观")
        rng = np.random.default_rng(seed)
        indices = rng.permutation(len(rows))
        first = max(1, int(len(rows) * 0.7))
        second = max(first + 1, int(len(rows) * 0.85))
        return (
            [rows[i] for i in indices[:first]],
            [rows[i] for i in indices[first:second]],
            [rows[i] for i in indices[second:]],
            {"method": "random", "groups": len(groups)},
        )

    by_group: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_group[row["uid"]].append(row)
    group_counts = {uid: len(items) for uid, items in by_group.items()}
    hard_groups = {
        row["uid"] for row in rows if row.get("must_train")
    }
    # 已审核的误判样本必须进入训练集，不能被随机分到测试/验证。
    negative_groups = [
        uid for uid, items in by_group.items() if any(row["label"] == 0 for row in items)
    ]
    positive_groups = [uid for uid in groups if uid not in set(negative_groups)]
    negative_groups = [uid for uid in negative_groups if uid not in hard_groups]
    positive_groups = [uid for uid in positive_groups if uid not in hard_groups]
    rng = np.random.default_rng(seed)
    rng.shuffle(negative_groups)
    rng.shuffle(positive_groups)

    test_groups: set[str] = set()
    valid_groups: set[str] = set()

    def take_by_rows(pool: list[str], target_rows: int) -> tuple[list[str], list[str]]:
        selected: list[str] = []
        remaining: list[str] = []
        accumulated = 0
        for index, uid in enumerate(pool):
            if selected and accumulated >= target_rows:
                remaining.extend(pool[index:])
                break
            selected.append(uid)
            accumulated += group_counts[uid]
        return selected, remaining

    # 按“行数”而不是“账号数”分配测试/验证，避免一个大账号主导某一类。
    pos_total = sum(group_counts[uid] for uid in positive_groups)
    neg_total = sum(group_counts[uid] for uid in negative_groups)
    test_pos, rest_pos = take_by_rows(positive_groups, round(pos_total * 0.2))
    valid_pos, train_pos = take_by_rows(rest_pos, round(pos_total * 0.2))
    test_neg, rest_neg = take_by_rows(negative_groups, round(neg_total * 0.2))
    valid_neg, train_neg = take_by_rows(rest_neg, round(neg_total * 0.2))

    test_groups.update(test_pos)
    test_groups.update(test_neg)
    valid_groups.update(valid_pos)
    valid_groups.update(valid_neg)

    if not train_pos and valid_pos:
        train_pos.append(valid_pos.pop())
    if not train_neg and valid_neg:
        train_neg.append(valid_neg.pop())

    train = [row for row in rows if row["uid"] not in test_groups and row["uid"] not in valid_groups]
    valid = [row for row in rows if row["uid"] in valid_groups]
    test = [row for row in rows if row["uid"] in test_groups]
    info = {
        "method": "group_by_uid_row_target",
        "groups": len(groups),
        "testGroups": len(test_groups),
        "validGroups": len(valid_groups),
        "testClasses": class_counts(test),
        "validClasses": class_counts(valid),
        "trainClasses": class_counts(train),
        "forcedTrainGroups": len(hard_groups),
    }
    return train, valid, test, info

def class_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(row["label"] for row in rows)
    return {"positive": counts.get(1, 0), "negative": counts.get(0, 0)}


def sigmoid(value: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-value))


def choose_threshold(labels: np.ndarray, probabilities: np.ndarray, target_precision: float) -> tuple[float, dict]:
    candidates = np.unique(np.round(probabilities, 6))
    best = None
    best_precision = -1.0
    for threshold in candidates:
        predictions = probabilities >= threshold
        if predictions.sum() == 0 or labels.sum() == 0:
            continue
        precision = precision_score(labels, predictions, zero_division=0)
        recall = recall_score(labels, predictions, zero_division=0)
        if precision >= target_precision:
            if best is None or recall > best[1]:
                best = (float(threshold), float(recall), float(precision))
        if precision > best_precision:
            best_precision = float(precision)
    if best is not None:
        threshold, recall, precision = best
        return threshold, {"mode": "target_precision", "precision": precision, "recall": recall}
    threshold = 0.5
    return threshold, {
        "mode": "fallback_0.5",
        "precision": float(best_precision) if best_precision >= 0 else 0.0,
        "recall": 0.0,
    }


def metrics_at(labels: np.ndarray, probabilities: np.ndarray, threshold: float) -> dict[str, Any]:
    predictions = (probabilities >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(labels, predictions, labels=[0, 1]).ravel()
    result = {
        "precision": float(precision_score(labels, predictions, zero_division=0)),
        "recall": float(recall_score(labels, predictions, zero_division=0)),
        "f1": float(f1_score(labels, predictions, zero_division=0)),
        "truePositive": int(tp),
        "falsePositive": int(fp),
        "trueNegative": int(tn),
        "falseNegative": int(fn),
    }
    if len(set(labels.tolist())) > 1:
        result["rocAuc"] = float(roc_auc_score(labels, probabilities))
        result["prAuc"] = float(average_precision_score(labels, probabilities))
    return result


def quantize_weights(coefficients: np.ndarray) -> tuple[np.ndarray, float]:
    max_abs = float(np.max(np.abs(coefficients))) if coefficients.size else 0.0
    scale = max_abs / 127.0 if max_abs > 0 else 1.0
    quantized = np.clip(np.round(coefficients / scale), -127, 127).astype(np.int16)
    return quantized, scale


def main() -> int:
    parser = argparse.ArgumentParser(description="训练 pkillFish 轻量文本模型")
    parser.add_argument("--data", action="append", default=[], help="数据目录或 JSONL，可重复")
    parser.add_argument("--negatives", action="append", default=[], help="额外负样本文件，可重复")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent / "artifacts" / "model.json"))
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--buckets", type=int, default=65536)
    parser.add_argument("--ngram-min", type=int, default=1)
    parser.add_argument("--ngram-max", type=int, default=4)
    parser.add_argument("--target-precision", type=float, default=0.95)
    parser.add_argument("--min-samples", type=int, default=200)
    parser.add_argument("--C", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=20261001)
    parser.add_argument("--since", default="2026-10-01", help="正样本最早日期；负样本不受限")
    parser.add_argument("--blacklist", default=str(ROOT / "blacklist.json"))
    parser.add_argument(
        "--include-pre-cutoff-negatives",
        action="store_true",
        help="把 negatives.jsonl（2026-10 前旧评论）也作为负样本；默认不加载，避免标签噪声",
    )
    args = parser.parse_args()

    data_paths = [Path(p) for p in args.data] or [Path(__file__).resolve().parent / "data"]
    data_paths.extend(Path(p) for p in args.negatives)
    rows = load_rows(data_paths, include_precut=args.include_pre_cutoff_negatives)
    tz = ZoneInfo("Asia/Shanghai")
    since = datetime.fromisoformat(args.since).replace(tzinfo=tz)
    filtered: list[dict[str, Any]] = []
    dropped_old = 0
    dropped_undated = 0
    for row in rows:
        if row["label"] == 0:
            filtered.append(row)
            continue
        try:
            created = datetime.fromisoformat(row["ctime"].replace("Z", "+00:00"))
            if created.tzinfo is None:
                created = created.replace(tzinfo=tz)
            created = created.astimezone(tz)
        except (ValueError, TypeError):
            dropped_undated += 1
            continue
        if created < since:
            dropped_old += 1
            continue
        filtered.append(row)
    if dropped_old:
        log(f"丢弃 {dropped_old} 条 2026-10-01 之前的正样本")
    if dropped_undated:
        log(f"丢弃 {dropped_undated} 条没有合法 ctime 的正样本")
    # 新加入黑名单的账号，其旧评论不应继续作为负样本；
    # 否则同一个 UID 会同时出现在正负两类里。
    blacklist = json.loads(Path(args.blacklist).read_text(encoding="utf-8"))
    blacklisted = {str(entry.get("mid")) for entry in blacklist.get("entries", []) if isinstance(entry, dict)}
    before = len(filtered)
    kept: list[dict[str, Any]] = []
    for row in filtered:
        if row["label"] == 0 and row["uid"] in blacklisted:
            # 同一账号在 2026-10 之前的评论可以作为 hard negative；
            # 没有时间的正常评论如果账号后来进了黑名单，则不能继续当负样本。
            try:
                created = datetime.fromisoformat(row["ctime"].replace("Z", "+00:00"))
                if created.tzinfo is None:
                    created = created.replace(tzinfo=tz)
                if created.astimezone(tz) < since:
                    kept.append(row)
                    continue
            except (ValueError, TypeError):
                pass
            continue
        kept.append(row)
    filtered = kept
    if before != len(filtered):
        log(f"移除 {before - len(filtered)} 条来自当前黑名单账号、且不在 2026-10 前的负样本")
    rows = dedupe_rows(filtered)
    if not rows:
        log("没有可用样本")
        return 2

    counts = class_counts(rows)
    log(f"样本：{len(rows)}；正 {counts['positive']}，负 {counts['negative']}")
    if counts["positive"] == 0 or counts["negative"] == 0:
        log("必须同时有正样本和负样本。可用 --include-before-as-negatives 采集同账号人类时期评论，或提供 --negatives。")
        return 2
    if len(rows) < args.min_samples:
        log(f"样本少于 --min-samples={args.min_samples}，默认拒绝训练以避免过拟合；可显式调低。")
        return 2

    train, valid, test, split_info = split_groups(rows, args.seed)
    log(f"切分：train={len(train)} valid={len(valid)} test={len(test)} {split_info}")

    spec = {
        "version": FEATURE_VERSION,
        "normalization": "nfkc-lower-url-mention-modelmask-v2",
        "ngramMin": args.ngram_min,
        "ngramMax": args.ngram_max,
        "buckets": args.buckets,
        "hash": "fnv1a32",
    }

    def matrix(part: list[dict[str, Any]]) -> csr_matrix:
        indptr = [0]
        indices: list[int] = []
        data: list[float] = []
        for row in part:
            features = sorted(hashed_features(row["text"], spec))
            indices.extend(features)
            data.extend([1.0] * len(features))
            indptr.append(len(indices))
        return csr_matrix(
            (np.asarray(data, dtype=np.float32), np.asarray(indices, dtype=np.int32), np.asarray(indptr, dtype=np.int32)),
            shape=(len(part), args.buckets),
        )

    x_train = matrix(train)
    y_train = np.asarray([row["label"] for row in train], dtype=np.int8)
    w_train = np.asarray([float(row.get("weight", 1.0)) for row in train], dtype=np.float64)
    x_valid = matrix(valid)
    y_valid = np.asarray([row["label"] for row in valid], dtype=np.int8)
    x_test = matrix(test)
    y_test = np.asarray([row["label"] for row in test], dtype=np.int8)

    model = LogisticRegression(
        C=args.C,
        class_weight="balanced",
        solver="liblinear",
        max_iter=3000,
        random_state=args.seed,
    )
    model.fit(x_train, y_train, sample_weight=w_train)

    valid_prob = model.predict_proba(x_valid)[:, 1]
    threshold, threshold_info = choose_threshold(y_valid, valid_prob, args.target_precision)
    test_prob = model.predict_proba(x_test)[:, 1]
    test_metrics = metrics_at(y_test, test_prob, threshold)

    coefficients = model.coef_[0].astype(np.float64)
    quantized, quant_scale = quantize_weights(coefficients)
    quant_valid_prob = sigmoid(
        model.intercept_[0] + quant_scale * np.asarray(x_valid @ quantized.astype(np.float64)).ravel()
    )
    quant_threshold, quant_threshold_info = choose_threshold(
        y_valid, quant_valid_prob, args.target_precision
    )
    quant_test_prob = sigmoid(
        model.intercept_[0] + quant_scale * np.asarray(x_test @ quantized.astype(np.float64)).ravel()
    )
    quant_test_metrics = metrics_at(y_test, quant_test_prob, quant_threshold)

    model_bytes = bytes((int(value) & 0xFF) for value in quantized.tolist())
    payload = {
        "format": FORMAT,
        "version": args.version,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "features": spec,
        "bias": float(model.intercept_[0]),
        "quantScale": float(quant_scale),
        "weights": base64.b64encode(model_bytes).decode("ascii"),
        "threshold": float(quant_threshold),
        "metrics": {
            "targetPrecision": args.target_precision,
            "validation": quant_threshold_info,
            "test": quant_test_metrics,
            "floatTest": test_metrics,
        },
        "training": {
            "samples": len(rows),
            "classes": counts,
            "split": split_info,
            "uidGroups": len({row["uid"] for row in rows}),
            "seed": args.seed,
            "C": args.C,
            "dedupe": "normalized-text",
        },
        "modelSha256": hashlib.sha256(model_bytes).hexdigest(),
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    card = "\n".join(
        [
            "# pkillFish ML model card",
            "",
            f"- version: `{args.version}`",
            f"- created: `{payload['createdAt']}`",
            f"- format: `{FORMAT}`",
            f"- samples: {len(rows)} ({counts['positive']} positive / {counts['negative']} negative)",
            f"- UID groups: {len({row['uid'] for row in rows})}",
            f"- threshold (int8): `{quant_threshold:.6f}`",
            f"- validation precision: `{quant_threshold_info['precision']:.4f}`",
            f"- validation recall: `{quant_threshold_info['recall']:.4f}`",
            f"- test precision: `{quant_test_metrics['precision']:.4f}`",
            f"- test recall: `{quant_test_metrics['recall']:.4f}`",
            f"- test false positives: {quant_test_metrics['falsePositive']}",
            f"- test false negatives: {quant_test_metrics['falseNegative']}",
            "",
            "这是实验性模型。标签来自社区审核和样本采集，可能存在偏差；",
            "不要把它当作绝对事实，误判时优先使用本地白名单。",
        ]
    )
    card_path = out_path.with_suffix(".card.md")
    card_path.write_text(card + "\n", encoding="utf-8")

    log(f"模型：{out_path} ({out_path.stat().st_size} bytes)")
    log(f"模型卡：{card_path}")
    log(
        "int8 测试指标："
        f"precision={quant_test_metrics['precision']:.4f}, "
        f"recall={quant_test_metrics['recall']:.4f}, "
        f"F1={quant_test_metrics['f1']:.4f}, "
        f"FP={quant_test_metrics['falsePositive']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

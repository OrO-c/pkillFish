/**
 * 独立关键词规则的解析、校验与匹配。
 *
 * 与 UID 黑名单完全分离：
 *   - nameKeywords 命中昵称即自动屏蔽；
 *   - commentKeywords 命中评论正文即自动屏蔽。
 *
 * 工作流会用同一份 keywords.json 检查用户强行提交的 Issue，
 * 命中当前规则就拒绝加入 UID 黑名单。
 */

export const KEYWORD_SCHEMA_VERSION = 1;
export const MAX_KEYWORDS = 500;
export const MAX_KEYWORD_LENGTH = 40;
export const KEYWORDS_FILE_LIMIT = 2 * 1024 * 1024;

export function cleanKeyword(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .slice(0, MAX_KEYWORD_LENGTH);
}

export function normalizeMatchText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeKeywordList(value, label, errors, warnings) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label} 必须是数组`);
    return [];
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < value.length && out.length < MAX_KEYWORDS; i += 1) {
    const keyword = cleanKeyword(value[i]);
    if (!keyword) {
      warnings.push(`${label}[${i}] 为空或标题超长，已忽略`);
      continue;
    }
    const key = keyword.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`${label}[${i}] 关键词重复，已忽略`);
      continue;
    }
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

export function validateKeywords(input) {
  const errors = [];
  const warnings = [];
  const doc = {
    schemaVersion: KEYWORD_SCHEMA_VERSION,
    version: 0,
    updatedAt: '',
    nameKeywords: [],
    commentKeywords: []
  };

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push('关键词根节点必须是 JSON 对象');
    return { ok: false, errors, warnings, doc };
  }
  if (input.schemaVersion !== KEYWORD_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 ${KEYWORD_SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    errors.push('version 必须是正整数');
  } else {
    doc.version = input.version;
  }
  if (typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt))) {
    errors.push('updatedAt 必须是合法的 ISO 时间');
  } else {
    doc.updatedAt = new Date(input.updatedAt).toISOString();
  }

  doc.nameKeywords = normalizeKeywordList(input.nameKeywords, 'nameKeywords', errors, warnings);
  doc.commentKeywords = normalizeKeywordList(
    input.commentKeywords,
    'commentKeywords',
    errors,
    warnings
  );

  return { ok: errors.length === 0, errors, warnings, doc };
}

export function matchKeywords(doc, { uname, text } = {}) {
  if (!doc) return null;
  const normalizedUname = normalizeMatchText(uname);
  const normalizedText = normalizeMatchText(text);

  for (const keyword of doc.nameKeywords || []) {
    const normalized = normalizeMatchText(keyword);
    if (normalized && normalizedUname.includes(normalized)) {
      return { kind: 'name', keyword };
    }
  }

  for (const keyword of doc.commentKeywords || []) {
    const normalized = normalizeMatchText(keyword);
    if (normalized && normalizedText.includes(normalized)) {
      return { kind: 'comment', keyword };
    }
  }

  return null;
}

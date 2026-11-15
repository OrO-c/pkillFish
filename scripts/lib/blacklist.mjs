/**
 * 黑名单数据模型与校验。
 *
 * 这个文件同时被流水线和单元测试使用，不依赖任何第三方包。
 * 安全原则：
 *   - 只复制已知字段，绝不把用户输入当作对象键展开；
 *   - 所有字符串设上限，移除控制字符；
 *   - 入口严格校验，失败时宁可拒绝，也不写入半成品。
 */

export const SCHEMA_VERSION = 1;
export const MAX_ENTRIES = 50000;
export const MAX_REVOKED = 50000;
export const MAX_RULES = 100;
export const MAX_REASON = 180;
export const MAX_FILE_BYTES = 6 * 1024 * 1024;

export const MID_RE = /^[1-9]\d{0,18}$/;
export const AVATAR_KEY_RE = /^[a-z0-9._-]{3,80}$/;

// reason 是旧字段：读取时兼容并丢弃，不再写入 blacklist.json。
const KNOWN_ENTRY_KEYS = new Set(['mid', 'reason', 'addedAt', 'reports']);
const KNOWN_TOP_KEYS = new Set([
  'schemaVersion',
  'version',
  'updatedAt',
  'entries',
  'revoked',
  'rules'
]);

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .slice(0, maxLength);
}

export function cleanReason(value) {
  return cleanString(value, MAX_REASON).replace(/\s+/g, ' ');
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

export function compareMid(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

export function sortEntries(entries) {
  return entries.slice().sort((a, b) => compareMid(a.mid, b.mid));
}

function uniqueStrings(values, maxLength, limit) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(values)) return out;
  for (const value of values) {
    const text = cleanString(value, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeEntryForDoc(raw, label, errors, warnings) {
  if (typeof raw === 'string' || typeof raw === 'number') {
    const mid = cleanString(String(raw), 20);
    if (!MID_RE.test(mid)) {
      errors.push(`${label}: UID 格式无效（必须是 1-19 位、非 0 开头的数字）`);
      return null;
    }
    return { mid, addedAt: '', reports: [] };
  }

  if (!isPlainObject(raw)) {
    errors.push(`${label}: 条目必须是对象或 UID 字符串`);
    return null;
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_ENTRY_KEYS.has(key)) warnings.push(`${label}: 忽略未知字段 ${key}`);
  }

  const mid = cleanString(String(raw.mid == null ? '' : raw.mid), 20);
  if (!MID_RE.test(mid)) {
    errors.push(`${label}: mid 格式无效`);
    return null;
  }

  let addedAt = '';
  if (raw.addedAt != null) {
    if (!isIsoDate(raw.addedAt)) {
      errors.push(`${label}: addedAt 不是合法时间`);
      return null;
    }
    addedAt = new Date(raw.addedAt).toISOString();
  }

  const reports = [];
  if (raw.reports != null) {
    if (!Array.isArray(raw.reports)) {
      errors.push(`${label}: reports 必须是数组`);
      return null;
    }
    for (const item of raw.reports) {
      const number = Number(item);
      if (!Number.isInteger(number) || number < 1 || number > 1000000000) {
        errors.push(`${label}: reports 中存在非法 Issue 编号`);
        return null;
      }
      if (!reports.includes(number)) reports.push(number);
      if (reports.length >= 200) break;
    }
  }

  return { mid, addedAt, reports };
}

/**
 * 严格校验一份黑名单（用于仓库文件与写入后的自检）。
 * @returns {{ok:boolean, errors:string[], warnings:string[], doc:object}}
 */
export function validateBlacklist(input) {
  const errors = [];
  const warnings = [];
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    version: 0,
    updatedAt: '',
    entries: [],
    revoked: [],
    rules: { nicknameKeywords: [], avatarHashes: [] }
  };

  if (!isPlainObject(input)) {
    errors.push('根节点必须是 JSON 对象');
    return { ok: false, errors, warnings, doc };
  }

  for (const key of Object.keys(input)) {
    if (!KNOWN_TOP_KEYS.has(key)) warnings.push(`忽略未知顶层字段 ${key}`);
  }

  if (input.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 ${SCHEMA_VERSION}`);
  }

  if (!Number.isInteger(input.version) || input.version < 1 || input.version > 1000000000) {
    errors.push('version 必须是 1 到 1e9 之间的整数');
  } else {
    doc.version = input.version;
  }

  if (!isIsoDate(input.updatedAt)) {
    errors.push('updatedAt 必须是合法的 ISO 时间');
  } else {
    doc.updatedAt = new Date(input.updatedAt).toISOString();
  }

  if (!Array.isArray(input.entries)) {
    errors.push('entries 必须是数组');
  } else if (input.entries.length > MAX_ENTRIES) {
    errors.push(`entries 超过上限 ${MAX_ENTRIES}`);
  } else {
    const seen = new Set();
    for (let i = 0; i < input.entries.length; i += 1) {
      const entry = normalizeEntryForDoc(input.entries[i], `entries[${i}]`, errors, warnings);
      if (!entry) continue;
      if (seen.has(entry.mid)) {
        errors.push(`entries[${i}]: UID ${entry.mid} 重复`);
        continue;
      }
      seen.add(entry.mid);
      doc.entries.push(entry);
    }
  }

  if (input.revoked != null) {
    if (!Array.isArray(input.revoked)) {
      errors.push('revoked 必须是数组');
    } else if (input.revoked.length > MAX_REVOKED) {
      errors.push(`revoked 超过上限 ${MAX_REVOKED}`);
    } else {
      const seen = new Set();
      for (let i = 0; i < input.revoked.length; i += 1) {
        const mid = cleanString(String(input.revoked[i] == null ? '' : input.revoked[i]), 20);
        if (!MID_RE.test(mid)) {
          errors.push(`revoked[${i}]: UID 格式无效`);
          continue;
        }
        if (seen.has(mid)) {
          warnings.push(`revoked[${i}]: UID ${mid} 重复`);
          continue;
        }
        seen.add(mid);
        doc.revoked.push(mid);
      }
    }
  }

  if (input.rules != null) {
    if (!isPlainObject(input.rules)) {
      errors.push('rules 必须是对象');
    } else {
      for (const key of Object.keys(input.rules)) {
        if (key !== 'nicknameKeywords' && key !== 'avatarHashes') {
          warnings.push(`rules: 忽略未知字段 ${key}`);
        }
      }
      doc.rules.nicknameKeywords = uniqueStrings(
        input.rules.nicknameKeywords,
        40,
        MAX_RULES
      );
      doc.rules.avatarHashes = uniqueStrings(input.rules.avatarHashes, 80, MAX_RULES)
        .map((value) => value.toLowerCase())
        .filter((value) => AVATAR_KEY_RE.test(value));
    }
  }

  const entryMids = new Set(doc.entries.map((entry) => entry.mid));
  for (const mid of doc.revoked) {
    if (entryMids.has(mid)) {
      errors.push(`UID ${mid} 同时出现在 entries 和 revoked 中`);
    }
  }

  const sorted = sortEntries(doc.entries);
  for (let i = 0; i < doc.entries.length; i += 1) {
    if (doc.entries[i].mid !== sorted[i].mid) {
      warnings.push('entries 未按 UID 排序，写入时会自动排序');
      break;
    }
  }
  doc.entries = sorted;
  doc.revoked.sort(compareMid);

  return { ok: errors.length === 0, errors, warnings, doc };
}

/**
 * 解析远端文件：支持 JSON 对象、JSON 数组、纯文本 UID 名单。
 * 纯文本示例：
 *   123456789
 *   987654321 # 模板话术
 */
export function parseBlacklistText(text) {
  const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('内容为空');

  if (raw.startsWith('{') || raw.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`JSON 解析失败：${error.message}`);
    }
    if (Array.isArray(parsed)) return { entries: parsed };
    return parsed;
  }

  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const match = trimmed.match(/^(\d{1,19})(?:\s*(?:#|\||--|,|-|\s)\s*(.*))?$/);
    if (!match) continue;
    entries.push({ mid: match[1] });
  }

  if (!entries.length) throw new Error('文本中没有可解析的 UID');
  return {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    updatedAt: new Date().toISOString(),
    entries,
    revoked: [],
    rules: { nicknameKeywords: [], avatarHashes: [] }
  };
}

/**
 * 增量合并：远端覆盖缓存，缓存中远端未出现的条目保留（防止临时坏数据抹掉历史），
 * 需要删除的 UID 必须写入 revoked（墓碑），这是明确的安全设计。
 */
export function mergeBlacklists(cached, remote) {
  const map = new Map();
  for (const entry of cached.entries || []) map.set(entry.mid, entry);
  for (const entry of remote.entries || []) map.set(entry.mid, entry);

  const revoked = new Set([...(cached.revoked || []), ...(remote.revoked || [])]);
  for (const mid of revoked) map.delete(mid);

  const keywords = uniqueStrings(
    [...(cached.rules?.nicknameKeywords || []), ...(remote.rules?.nicknameKeywords || [])],
    40,
    MAX_RULES
  );
  const avatars = uniqueStrings(
    [...(cached.rules?.avatarHashes || []), ...(remote.rules?.avatarHashes || [])],
    80,
    MAX_RULES
  )
    .map((value) => value.toLowerCase())
    .filter((value) => AVATAR_KEY_RE.test(value));

  return {
    schemaVersion: SCHEMA_VERSION,
    version: Math.max(Number(cached.version) || 0, Number(remote.version) || 0),
    updatedAt: remote.updatedAt || cached.updatedAt || new Date().toISOString(),
    entries: sortEntries(
      [...map.values()]
        .filter((entry) => !revoked.has(entry.mid))
        .map((entry) => ({
          mid: entry.mid,
          addedAt: entry.addedAt || '',
          reports: Array.isArray(entry.reports) ? entry.reports : []
        }))
    ),
    revoked: [...revoked].sort(compareMid),
    rules: { nicknameKeywords: keywords, avatarHashes: avatars }
  };
}

export function buildEntry(mid, issueNumber, now = new Date()) {
  const normalizedMid = cleanString(String(mid == null ? '' : mid), 20);
  if (!MID_RE.test(normalizedMid)) throw new Error(`UID 格式无效：${mid}`);
  return {
    mid: normalizedMid,
    addedAt: now.toISOString(),
    reports: Number.isInteger(issueNumber) && issueNumber > 0 ? [issueNumber] : []
  };
}

export function formatSummary(doc) {
  return `${doc.entries.length} 条 / revoked ${doc.revoked.length} 条 / version ${doc.version}`;
}

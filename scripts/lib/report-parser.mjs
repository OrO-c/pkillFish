/**
 * 解析用户脚本预填的 GitHub Issue 正文。
 *
 * 只做文本解析，不执行 Issue 中的任何内容，也不访问 B 站 API。
 * 任何字段不合法都返回错误，由 workflow 拒绝自动合并。
 */

import { cleanString, isIsoDate, MID_RE } from './blacklist.mjs';

const ALLOWED_HOSTS = new Set([
  'bilibili.com',
  'www.bilibili.com',
  'm.bilibili.com',
  't.bilibili.com',
  'space.bilibili.com'
]);

const MAX_BODY = 30000;
const MAX_COMMENT = 20000;
const MAX_BATCH_REPORTS = 30;

export function parseMetaBlock(body) {
  const text = String(body == null ? '' : body);
  const match = text.match(/<!--\s*pkillfish:meta\s*([\s\S]*?)-->/i);
  if (!match) return {};

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    if (/^[a-z][a-z0-9_]{0,20}$/.test(key)) meta[key] = value;
  }
  return meta;
}

export function parseBatchBlock(body) {
  const text = String(body == null ? '' : body);
  const match = text.match(/<!--\s*pkillfish:batch\s*([\s\S]*?)-->/i);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (error) {
    throw new Error(`pkillfish:batch JSON 解析失败：${error.message}`);
  }
  if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.reports)) {
    parsed = parsed.reports;
  }
  if (!Array.isArray(parsed)) {
    throw new Error('pkillfish:batch 必须是数组');
  }
  return parsed;
}

export function normalizeBilibiliLink(value) {
  let text = cleanString(value, 500);
  if (!text) return '';
  if (text.startsWith('//')) text = 'https:' + text;
  text = text.replace(/[),.;，。；）]+$/g, '');
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return '';
    if (url.hostname.toLowerCase() === 'space.bilibili.com') return '';
    if (!url.pathname || url.pathname === '/') return '';
    url.protocol = 'https:';
    url.hash = url.hash || '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

export function extractCommentText(body) {
  const text = String(body == null ? '' : body);

  const fenced = text.match(
    /###\s*可疑评论[\s\S]*?(?:```|~~~)(?:text|markdown)?\s*\r?\n([\s\S]*?)\r?\n(?:```|~~~)/i
  );
  if (fenced) return cleanString(fenced[1], MAX_COMMENT) ? fenced[1].trim().slice(0, MAX_COMMENT) : '';

  const section = text.match(/###\s*可疑评论\s*\r?\n([\s\S]*?)(?:\r?\n###\s|$)/i);
  if (section) {
    return section[1].trim().slice(0, MAX_COMMENT);
  }
  return '';
}

export function isPlaceholderComment(text) {
  return !text || /未获取到评论原文|请手动粘贴|无文本|在此粘贴评论原文|请粘贴评论原文/.test(text);
}

/**
 * @returns {{ok:boolean, errors:string[], meta:{uid:string,mid:string,rpid:string,oid:string,type:string,link:string}, commentText:string}}
 */
export function parseIssueBody(body) {
  const errors = [];
  const warnings = [];
  const raw = String(body == null ? '' : body);

  if (raw.length > MAX_BODY) {
    errors.push(`Issue 正文超过 ${MAX_BODY} 字符上限`);
  }
  if (raw.length < 80) {
    errors.push('Issue 正文过短，拒绝自动处理');
  }

  let batch = null;
  try {
    batch = parseBatchBlock(raw);
  } catch (error) {
    errors.push(error.message);
  }

  if (batch) {
    if (batch.length === 0) {
      errors.push('批量上报为空');
    }
    if (batch.length > MAX_BATCH_REPORTS) {
      errors.push(`批量上报超过 ${MAX_BATCH_REPORTS} 条上限`);
    }

    const reports = [];
    const seen = new Set();
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i];
      if (!item || typeof item !== 'object') {
        errors.push(`批量上报第 ${i + 1} 条不是对象`);
        continue;
      }
      const mid = cleanString(String(item.mid == null ? '' : item.mid), 20);
      const rpid = cleanString(String(item.rpid == null ? '' : item.rpid), 20);
      const oid = cleanString(String(item.oid == null ? '' : item.oid), 20);
      const type = cleanString(String(item.type == null ? '' : item.type), 8);
      const link = normalizeBilibiliLink(item.link || '');
      const uname = cleanString(String(item.uname == null ? '' : item.uname), 80);
      const text = cleanString(String(item.text == null ? '' : item.text), 500);

      if (!MID_RE.test(mid)) {
        errors.push(`批量上报第 ${i + 1} 条 UID 无效`);
        continue;
      }
      if (rpid && !/^[1-9]\d{0,18}$/.test(rpid)) {
        errors.push(`批量上报第 ${i + 1} 条 rpid 无效`);
        continue;
      }
      if (oid && !/^[1-9]\d{0,18}$/.test(oid)) {
        errors.push(`批量上报第 ${i + 1} 条 oid 无效`);
        continue;
      }
      if (type && !/^\d{1,3}$/.test(type)) {
        errors.push(`批量上报第 ${i + 1} 条 type 无效`);
        continue;
      }
      if (!link) {
        errors.push(`批量上报第 ${i + 1} 条缺少合法评论链接`);
        continue;
      }
      if (seen.has(mid)) {
        warnings.push(`批量上报第 ${i + 1} 条与前面的 UID ${mid} 重复，已合并`);
        continue;
      }
      seen.add(mid);
      reports.push({ uid: mid, mid, rpid, oid, type, link, uname, text });
    }

    if (!reports.length) {
      errors.push('批量上报中没有可用的 UID');
    }

    const first = reports[0] || { uid: '', mid: '', rpid: '', oid: '', type: '', link: '' };
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      meta: first,
      reports,
      commentText: ''
    };
  }

  // 兼容旧版单条 Issue：pkillfish:meta + 可疑评论原文。
  const meta = parseMetaBlock(raw);
  let uid = cleanString(meta.uid || '', 20);
  let mid = cleanString(meta.mid || '', 20);
  const rpid = cleanString(meta.rpid || '', 20);
  const oid = cleanString(meta.oid || '', 20);
  const type = cleanString(meta.type || '', 8);

  let link = normalizeBilibiliLink(meta.link || '');
  if (!link) {
    const candidates = raw.match(/https?:\/\/(?:www|m|t|space)\.bilibili\.com\/[^\s)<>"']+/gi) || [];
    for (const candidate of candidates) {
      const normalized = normalizeBilibiliLink(candidate);
      if (normalized) {
        link = normalized;
        break;
      }
    }
  }

  if (!uid) {
    const uidMatch = raw.match(/(?:B站\s*UID|UID|uid)\s*[:：]\s*([0-9]{1,19})/);
    if (uidMatch) uid = uidMatch[1];
  }
  if (!mid) {
    const midMatch = raw.match(/\bmid\s*[:：]\s*([0-9]{1,19})/i);
    if (midMatch) mid = midMatch[1];
  }
  if (!mid) {
    const spaceMatch = raw.match(/space\.bilibili\.com\/([0-9]{1,19})/);
    if (spaceMatch) mid = spaceMatch[1];
  }

  if (!uid && mid) uid = mid;
  if (uid && mid && uid !== mid) errors.push('uid 与 mid 不一致');
  if (!uid && !mid) errors.push('缺少 UID / mid');
  const finalMid = mid || uid;

  if (!MID_RE.test(finalMid)) {
    errors.push('UID / mid 格式无效（必须是 1-19 位、非 0 开头的数字）');
  }
  if (uid && !MID_RE.test(uid)) errors.push('uid 格式无效');
  if (rpid && !/^[1-9]\d{0,18}$/.test(rpid)) errors.push('rpid 格式无效');
  if (oid && !/^[1-9]\d{0,18}$/.test(oid)) errors.push('oid 格式无效');
  if (type && !/^\d{1,3}$/.test(type)) errors.push('type 格式无效');
  if (!link) errors.push('缺少合法的 B 站评论链接');

  const unameMatch = raw.match(/(?:^|\n)\s*-?\s*昵称\s*[:：]\s*([^\n]+)/);
  const uname = unameMatch ? cleanString(unameMatch[1], 80) : '';

  const commentText = extractCommentText(raw);
  if (isPlaceholderComment(commentText)) {
    errors.push('缺少评论原文');
  }

  const report = {
    uid: uid || finalMid,
    mid: finalMid,
    rpid,
    oid,
    type,
    link,
    uname,
    text: commentText
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    meta: report,
    reports: errors.length === 0 || finalMid ? [report] : [],
    commentText
  };
}

export function reasonFromIssue(title, issueNumber) {
  let text = cleanString(title || '', 160).replace(/^\[fish-report\]\s*/i, '');
  text = text.replace(/\(#\d+\)$/, '').trim();
  // 默认标题只包含 UID / rpid，不能当作有意义的理由。
  text = text
    .replace(/^UID\s*\d+\s*/i, '')
    .replace(/^\/?\s*rpid\s*\d+\s*/i, '')
    .replace(/^[/|\-\s]+/, '')
    .trim();
  if (!text || /^UID\b/i.test(text)) {
    text = 'DSH / 大肥鱼 Agent 评论（社区上报）';
  }
  return cleanString(text, 180);
}

export function isValidIssueDate(value) {
  return isIsoDate(value);
}

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
  const raw = String(body == null ? '' : body);
  const meta = parseMetaBlock(raw);

  if (raw.length > MAX_BODY) {
    errors.push(`Issue 正文超过 ${MAX_BODY} 字符上限`);
  }

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

  const commentText = extractCommentText(raw);
  if (isPlaceholderComment(commentText)) {
    errors.push('缺少评论原文');
  }

  if (raw.length < 80) {
    errors.push('Issue 正文过短，拒绝自动处理');
  }

  return {
    ok: errors.length === 0,
    errors,
    meta: {
      uid: uid || finalMid,
      mid: finalMid,
      rpid,
      oid,
      type,
      link
    },
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

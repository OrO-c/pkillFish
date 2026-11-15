#!/usr/bin/env node
/**
 * 处理已标记 resolved 的上报 Issue。
 *
 * 输入（环境变量，由 workflow 注入）：
 *   ISSUE_BODY, ISSUE_TITLE, ISSUE_NUMBER, GITHUB_REPOSITORY
 *
 * 行为：
 *   1. 严格解析 Issue 正文中的 pkillfish:meta（单条）或 pkillfish:batch（批量）区块；
 *   2. 读取 keywords.json，拒绝命中当前自动关键词规则的强行上报；
 *   3. 二次校验现有 blacklist.json；
 *   4. 新 UID 追加条目；已有 UID 只补充 reports 证据；
 *   5. 再次校验后原子写入；
 *   6. 新条目写入变更日志；
 *   7. 输出 changed / mid / mids / action / count / added / reported / duplicate 给 workflow。
 *
 * 不访问网络，不调用 B 站 API，不执行 Issue 中的任何代码。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_ENTRIES,
  buildEntry,
  cleanReason,
  formatSummary,
  validateBlacklist
} from './lib/blacklist.mjs';
import { parseIssueBody, reasonFromIssue } from './lib/report-parser.mjs';
import { matchKeywords, validateKeywords } from './lib/keywords.mjs';

const BLACKLIST_FILE = process.env.BLACKLIST_FILE || 'blacklist.json';
const CHANGELOG_FILE = process.env.CHANGELOG_FILE || 'docs/blacklist-changelog.md';
const KEYWORDS_FILE = process.env.KEYWORDS_FILE || 'keywords.json';
const issueNumber = Number(process.env.ISSUE_NUMBER || 0);
const issueTitle = process.env.ISSUE_TITLE || '';
const issueBody = process.env.ISSUE_BODY || '';
const repository = process.env.GITHUB_REPOSITORY || 'OrO-c/pkillFish';

function fail(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function readJson(file) {
  const absolute = path.resolve(process.cwd(), file);
  const text = fs.readFileSync(absolute, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${file} 不是合法 JSON：${error.message}`);
  }
}

function writeJsonAtomic(file, value) {
  const absolute = path.resolve(process.cwd(), file);
  const temp = `${absolute}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, absolute);
}

function setOutput(name, value) {
  const line = `${name}=${String(value).replace(/\r?\n/g, ' ')}\n`;
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, line, 'utf8');
  } else {
    process.stdout.write(line);
  }
}

function appendSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, 'utf8');
  }
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/([\\`*_{}[\]()])/g, '\\$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function appendChangelog(entry, issue, action) {
  const absolute = path.resolve(process.cwd(), CHANGELOG_FILE);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });

  const header =
    '# 黑名单变更日志\n\n' +
    '本文件由 `.github/workflows/auto-blacklist.yml` 自动维护。\n' +
    '格式：日期 / 操作 / UID / Issue / 理由。请勿手工改变标题层级。\n\n';

  let text = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : header;
  if (!text.startsWith('# ')) text = header + text;

  const date = new Date().toISOString().slice(0, 10);
  const issueUrl = `https://github.com/${repository}/issues/${issue}`;
  const reason = escapeMarkdown(cleanReason(entry.reason || '社区上报'));
  const line =
    action === 'reported'
      ? `- 补充证据 UID ${entry.mid}（Issue [#${issue}](${issueUrl})）`
      : `- 新增 UID ${entry.mid}（Issue [#${issue}](${issueUrl})）：${reason}`;

  const heading = `## ${date}`;
  const headingIndex = text.indexOf(heading);

  if (headingIndex === -1) {
    text = `${text.trimEnd()}\n\n${heading}\n\n${line}\n`;
  } else {
    const afterHeading = headingIndex + heading.length;
    const nextHeading = text.indexOf('\n## ', afterHeading);
    const insertAt = nextHeading === -1 ? text.length : nextHeading;
    const before = text.slice(0, insertAt).trimEnd();
    const after = text.slice(insertAt);
    text = `${before}\n${line}\n${after}`;
  }

  fs.writeFileSync(absolute, text, 'utf8');
}

function main() {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    fail('ISSUE_NUMBER 无效');
  }
  if (!issueBody.trim()) {
    fail('ISSUE_BODY 为空');
  }

  const parsedIssue = parseIssueBody(issueBody);
  if (!parsedIssue.ok) {
    fail(`Issue 解析失败：${parsedIssue.errors.join('；')}`);
  }

  const reports = parsedIssue.reports || [];
  if (!reports.length) {
    fail('Issue 中没有可处理的 UID');
  }

  const validation = validateBlacklist(readJson(BLACKLIST_FILE));
  if (!validation.ok) {
    fail(`现有黑名单校验失败：${validation.errors.join('；')}`);
  }

  const keywordValidation = validateKeywords(readJson(KEYWORDS_FILE));
  if (!keywordValidation.ok) {
    fail(`关键词文件校验失败：${keywordValidation.errors.join('；')}`);
  }
  const keywordDoc = keywordValidation.doc;
  for (const report of reports) {
    if (
      keywordDoc.nameKeywords.length > 0 &&
      !String(report.uname || '').trim()
    ) {
      fail(`UID ${report.mid} 缺少昵称，无法检查关键词规则`);
    }
    if (
      keywordDoc.commentKeywords.length > 0 &&
      !String(report.text || '').trim()
    ) {
      fail(`UID ${report.mid} 缺少评论内容，无法检查关键词规则`);
    }
    const keywordHit = matchKeywords(keywordDoc, {
      uname: report.uname || '',
      text: report.text || ''
    });
    if (keywordHit) {
      fail(
        `UID ${report.mid} 命中关键词规则（` +
          (keywordHit.kind === 'name' ? '昵称' : '评论') +
          `：${keywordHit.keyword}），拒绝加入 UID 黑名单`
      );
    }
  }

  const doc = validation.doc;
  for (const report of reports) {
    if (doc.revoked.includes(report.mid)) {
      fail(`UID ${report.mid} 位于 revoked 列表，需维护者人工处理`);
    }
  }

  const results = [];
  const mids = [];
  let addedCount = 0;
  let reportedCount = 0;
  let duplicateCount = 0;
  let changed = false;

  for (const report of reports) {
    const mid = report.mid;
    mids.push(mid);
    const index = doc.entries.findIndex((entry) => entry.mid === mid);
    const existing = index >= 0 ? doc.entries[index] : null;

    if (existing) {
      if (!existing.reports.includes(issueNumber)) {
        existing.reports.push(issueNumber);
        if (existing.reports.length > 200) existing.reports = existing.reports.slice(-200);
        changed = true;
        results.push({ mid, action: 'reported' });
        reportedCount += 1;
      } else {
        results.push({ mid, action: 'duplicate' });
        duplicateCount += 1;
      }
    } else {
      if (doc.entries.length >= MAX_ENTRIES) {
        fail(`黑名单已达上限 ${MAX_ENTRIES}，拒绝自动追加`);
      }
      const reason = reasonFromIssue(issueTitle, issueNumber);
      doc.entries.push(buildEntry(mid, reason, issueNumber));
      changed = true;
      results.push({ mid, action: 'added' });
      addedCount += 1;
    }
  }

  if (changed) {
    doc.entries.sort((a, b) => {
      if (a.mid.length !== b.mid.length) return a.mid.length - b.mid.length;
      return a.mid < b.mid ? -1 : a.mid > b.mid ? 1 : 0;
    });
    doc.version = Math.max(1, Number(doc.version) + 1);
    doc.updatedAt = new Date().toISOString();

    const recheck = validateBlacklist(doc);
    if (!recheck.ok) {
      fail(`写入前校验失败：${recheck.errors.join('；')}`);
    }

    writeJsonAtomic(BLACKLIST_FILE, recheck.doc);

    for (const result of results) {
      if (result.action === 'duplicate') continue;
      const entry = recheck.doc.entries.find((item) => item.mid === result.mid);
      if (entry) appendChangelog(entry, issueNumber, result.action);
    }
  }

  const actions = [...new Set(results.map((result) => result.action))];
  const action = actions.length === 1 ? actions[0] : 'mixed';
  const midsText = mids.join(',');

  setOutput('changed', changed ? 'true' : 'false');
  setOutput('mid', mids[0] || '');
  setOutput('mids', midsText);
  setOutput('action', action);
  setOutput('count', doc.entries.length);
  setOutput('added', addedCount);
  setOutput('reported', reportedCount);
  setOutput('duplicate', duplicateCount);

  const actionText = actions.length === 1
    ? actions[0] === 'added'
      ? '新增黑名单条目'
      : actions[0] === 'reported'
        ? '补充 Issue 证据'
        : '重复上报，黑名单未变更'
    : '混合结果';

  for (const result of results) {
    const label = result.action === 'added'
      ? '新增'
      : result.action === 'reported'
        ? '补充证据'
        : '重复';
    console.log(`${label}: UID ${result.mid}`);
  }
  console.log(`${actionText}，共 ${reports.length} 条`);
  console.log(`当前黑名单: ${formatSummary(doc)}`);

  appendSummary(
    [
      '### pkillFish 黑名单自动处理',
      '',
      `- Issue: #${issueNumber}`,
      `- 处理: ${reports.length} 条`,
      `- 新增: ${addedCount}；补充证据: ${reportedCount}；重复: ${duplicateCount}`,
      `- 当前规模: ${doc.entries.length} 条（revoked ${doc.revoked.length} 条）`,
      `- 新版本: ${doc.version}`,
      '',
      '| UID | 结果 |',
      '|---|---|',
      ...results.map((result) => `| \`${result.mid}\` | ${result.action} |`),
      ''
    ].join('\n')
  );
}

try {
  main();
} catch (error) {
  if (!process.exitCode) process.exitCode = 1;
  console.error(error && error.stack ? error.stack : String(error));
}

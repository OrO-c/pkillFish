#!/usr/bin/env node
/**
 * 校验 blacklist.json。
 *
 * 用法：
 *   node scripts/validate-blacklist.mjs
 *   node scripts/validate-blacklist.mjs blacklist.json
 *
 * 退出码 0 表示通过；1 表示存在错误。警告不阻塞。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_FILE_BYTES,
  formatSummary,
  parseBlacklistText,
  validateBlacklist
} from './lib/blacklist.mjs';

const args = process.argv.slice(2);
const files = args.filter((arg) => !arg.startsWith('-'));
const targets = files.length ? files : ['blacklist.json'];

let failed = false;

for (const file of targets) {
  const absolute = path.resolve(process.cwd(), file);
  let text;

  try {
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`文件超过 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB 上限`);
    }
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    failed = true;
    console.error(`::error file=${file}::无法读取文件：${error.message}`);
    continue;
  }

  let parsed;
  try {
    parsed = parseBlacklistText(text);
  } catch (error) {
    failed = true;
    console.error(`::error file=${file}::解析失败：${error.message}`);
    continue;
  }

  const result = validateBlacklist(parsed);
  for (const warning of result.warnings) {
    console.warn(`::warning file=${file}::${warning}`);
  }
  for (const error of result.errors) {
    failed = true;
    console.error(`::error file=${file}::${error}`);
  }

  if (result.ok) {
    console.log(`OK ${file}: ${formatSummary(result.doc)}`);
  } else {
    console.error(`FAIL ${file}: ${result.errors.length} 个错误`);
  }
}

process.exitCode = failed ? 1 : 0;

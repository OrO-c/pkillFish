#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { KEYWORDS_FILE_LIMIT, validateKeywords } from './lib/keywords.mjs';

const file = process.argv.slice(2).find((arg) => !arg.startsWith('-')) || 'keywords.json';
const absolute = path.resolve(process.cwd(), file);

let text;
try {
  const stat = fs.statSync(absolute);
  if (stat.size > KEYWORDS_FILE_LIMIT) {
    throw new Error('文件超过 2MB 上限');
  }
  text = fs.readFileSync(absolute, 'utf8');
} catch (error) {
  console.error(`::error file=${file}::无法读取：${error.message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch (error) {
  console.error(`::error file=${file}::JSON 解析失败：${error.message}`);
  process.exit(1);
}

const result = validateKeywords(parsed);
for (const warning of result.warnings) console.warn(`::warning file=${file}::${warning}`);
for (const error of result.errors) console.error(`::error file=${file}::${error}`);

if (!result.ok) {
  console.error(`FAIL ${file}: ${result.errors.length} 个错误`);
  process.exit(1);
}

console.log(
  `OK ${file}: 昵称 ${result.doc.nameKeywords.length} 条 / 评论 ${result.doc.commentKeywords.length} 条`
);

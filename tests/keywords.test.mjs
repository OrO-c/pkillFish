import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchKeywords, validateKeywords } from '../scripts/lib/keywords.mjs';

function doc(overrides = {}) {
  return {
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-11-15T00:00:00.000Z',
    nameKeywords: [],
    commentKeywords: [],
    ...overrides
  };
}

test('仓库自带 keywords.json 通过校验', () => {
  const text = fs.readFileSync(new URL('../keywords.json', import.meta.url), 'utf8');
  const result = validateKeywords(JSON.parse(text));
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('关键词去重并规范化', () => {
  const result = validateKeywords(
    doc({
      nameKeywords: ['大肥鱼', '大肥鱼', ' ＤＳＨ ', ''],
      commentKeywords: ['DeepSeek Harness']
    })
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.doc.nameKeywords, ['大肥鱼', 'DSH']);
  assert.deepEqual(result.doc.commentKeywords, ['DeepSeek Harness']);
  assert.match(result.warnings.join('\n'), /重复/);
});

test('拒绝非法关键词结构', () => {
  const result = validateKeywords(doc({ nameKeywords: '大肥鱼' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /必须是数组/);
});

test('昵称关键词匹配', () => {
  const hit = matchKeywords(doc({ nameKeywords: ['大肥鱼'] }), {
    uname: '秋夜殿下の妹抖大肥鱼',
    text: '普通评论'
  });
  assert.deepEqual(hit, { kind: 'name', keyword: '大肥鱼' });
});

test('评论关键词匹配且不区分全角/大小写', () => {
  const d = doc({ commentKeywords: ['ＤＳＨ'] });
  const hit = matchKeywords(d, { uname: 'user', text: '这是 dsh 生成的评论' });
  assert.equal(hit.kind, 'comment');
});

test('没有命中返回 null', () => {
  assert.equal(
    matchKeywords(doc({ nameKeywords: ['大肥鱼'] }), {
      uname: 'normal',
      text: 'normal'
    }),
    null
  );
});

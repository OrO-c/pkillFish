import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCommentText,
  normalizeBilibiliLink,
  parseIssueBody,
  parseMetaBlock,
  reasonFromIssue
} from '../scripts/lib/report-parser.mjs';

function makeBody(overrides = {}) {
  const meta = {
    uid: '123456789',
    mid: '123456789',
    rpid: '3760801399',
    oid: '80433022',
    type: '1',
    link: 'https://www.bilibili.com/video/BV1GJ411x7h7/#reply3760801399',
    ...overrides
  };
  return `<!-- pkillfish:meta
uid: ${meta.uid}
mid: ${meta.mid}
rpid: ${meta.rpid}
oid: ${meta.oid}
type: ${meta.type}
link: ${meta.link}
-->

### 可疑评论

- UID: ${meta.uid}

~~~text
这是一条用于测试的评论原文，长度足够。
~~~

### 判断依据

- [ ] 批量 / 模板化评论

### 确认

- [ ] 我只提交了公开评论信息。
`;
}

test('解析 pkillFish 预填 Issue', () => {
  const parsed = parseIssueBody(makeBody());
  assert.equal(parsed.ok, true, parsed.errors.join('\n'));
  assert.equal(parsed.meta.mid, '123456789');
  assert.equal(parsed.meta.rpid, '3760801399');
  assert.match(parsed.meta.link, /#reply3760801399$/);
  assert.match(parsed.commentText, /测试的评论原文/);
});

test('拒绝 uid 与 mid 不一致', () => {
  const parsed = parseIssueBody(makeBody({ uid: '111', mid: '222' }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join('\n'), /不一致/);
});

test('拒绝非 B 站链接', () => {
  const parsed = parseIssueBody(makeBody({ link: 'https://evil.example.com/video/BV1' }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join('\n'), /B 站评论链接/);
});

test('拒绝占位评论原文', () => {
  const body = makeBody().replace('这是一条用于测试的评论原文，长度足够。', '（在此粘贴评论原文）');
  const parsed = parseIssueBody(body);
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join('\n'), /评论原文/);
});

test('拒绝过短正文', () => {
  const parsed = parseIssueBody('uid: 123456789\nhttps://www.bilibili.com/video/BV1\n');
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join('\n'), /过短/);
});

test('解析 HTML 注释 metadata', () => {
  const meta = parseMetaBlock(makeBody());
  assert.equal(meta.mid, '123456789');
  assert.equal(meta.type, '1');
});

test('支持反引号 fence 和波浪线 fence', () => {
  const backtick = makeBody().replace(/~~~text/g, '```text').replace(/\n~~~$/, '\n```');
  assert.match(extractCommentText(backtick), /测试的评论原文/);
  assert.match(extractCommentText(makeBody()), /测试的评论原文/);
});

test('规范化 B 站链接', () => {
  assert.equal(
    normalizeBilibiliLink('https://www.bilibili.com/video/BV1GJ411x7h7/#reply1'),
    'https://www.bilibili.com/video/BV1GJ411x7h7/#reply1'
  );
  assert.equal(normalizeBilibiliLink('//www.bilibili.com/opus/123#reply4'), 'https://www.bilibili.com/opus/123#reply4');
  assert.equal(normalizeBilibiliLink('https://space.bilibili.com/123'), '');
  assert.equal(normalizeBilibiliLink('javascript:alert(1)'), '');
});

test('默认 Issue 标题退化为可读理由', () => {
  assert.equal(
    reasonFromIssue('[fish-report] UID 123456789 / rpid 3760801399', 12),
    'DSH / 大肥鱼 Agent 评论（社区上报）'
  );
  assert.equal(reasonFromIssue('[fish-report] 批量模板评论', 12), '批量模板评论');
});

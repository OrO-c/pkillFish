import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildEntry,
  mergeBlacklists,
  parseBlacklistText,
  validateBlacklist
} from '../scripts/lib/blacklist.mjs';

function baseDoc(overrides = {}) {
  return {
    schemaVersion: 1,
    version: 3,
    updatedAt: '2026-11-15T00:00:00.000Z',
    entries: [{ mid: '123456789', reason: '测试', addedAt: '2026-11-15T00:00:00.000Z', reports: [1] }],
    revoked: [],
    rules: { nicknameKeywords: ['大肥鱼'], avatarHashes: [] },
    ...overrides
  };
}

test('仓库自带 blacklist.json 通过严格校验', () => {
  const text = fs.readFileSync(new URL('../blacklist.json', import.meta.url), 'utf8');
  const result = validateBlacklist(JSON.parse(text));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.doc.schemaVersion, 1);
});

test('拒绝重复 UID', () => {
  const result = validateBlacklist(
    baseDoc({
      entries: [
        { mid: '123456789', reason: 'a' },
        { mid: '123456789', reason: 'b' }
      ]
    })
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /重复/);
});

test('拒绝 entries 与 revoked 重叠', () => {
  const result = validateBlacklist(baseDoc({ revoked: ['123456789'] }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /同时出现/);
});

test('拒绝非法 UID 与非法时间', () => {
  const result = validateBlacklist(
    baseDoc({
      updatedAt: 'not-a-date',
      entries: [{ mid: '000123', reason: 'x' }]
    })
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /mid 格式无效/);
  assert.match(result.errors.join('\n'), /updatedAt/);
});

test('解析纯文本 UID 名单', () => {
  const parsed = parseBlacklistText('# comment\n123456789\n987654321 # 模板话术\n');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].mid, '123456789');
  assert.equal(parsed.entries[1].reason, '模板话术');
});

test('解析 JSON 数组名单', () => {
  const parsed = parseBlacklistText('["123456789", {"mid":"987654321","reason":"x"}]');
  assert.equal(parsed.entries.length, 2);
});

test('增量合并保留缓存条目，revoked 可删除，规则取并集', () => {
  const cached = baseDoc({
    entries: [
      { mid: '111', reason: 'cached', reports: [] },
      { mid: '222', reason: 'cached2', reports: [] }
    ],
    revoked: [],
    rules: { nicknameKeywords: ['大肥鱼'], avatarHashes: [] }
  });
  const remote = baseDoc({
    version: 4,
    entries: [{ mid: '333', reason: 'remote', reports: [] }],
    revoked: ['222'],
    rules: { nicknameKeywords: ['dsh agent'], avatarHashes: [] }
  });
  const merged = mergeBlacklists(cached, remote);
  assert.deepEqual(
    merged.entries.map((entry) => entry.mid),
    ['111', '333']
  );
  assert.deepEqual(merged.revoked, ['222']);
  assert.deepEqual(merged.rules.nicknameKeywords, ['大肥鱼', 'dsh agent']);
  assert.equal(merged.version, 4);
});

test('buildEntry 生成合法条目', () => {
  const entry = buildEntry('123456789', '  test  ', 7, new Date('2026-11-15T00:00:00Z'));
  assert.equal(entry.mid, '123456789');
  assert.equal(entry.reason, 'test');
  assert.deepEqual(entry.reports, [7]);
  assert.equal(entry.addedAt, '2026-11-15T00:00:00.000Z');
});

test('buildEntry 拒绝非法 UID', () => {
  assert.throws(() => buildEntry('abc', 'x', 1));
  assert.throws(() => buildEntry('0', 'x', 1));
});

# pkillFish

一个运行在浏览器用户脚本管理器中的 B 站评论区过滤器，用于静默隐藏 DSH / 大肥鱼 Agent 的批量评论。

[![Validate](https://github.com/OrO-c/pkillFish/actions/workflows/validate-blacklist.yml/badge.svg)](https://github.com/OrO-c/pkillFish/actions/workflows/validate-blacklist.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

- 只操作当前页面的 DOM，不调用 B 站 API，不自动举报，不修改服务端数据。
- 支持主评论、楼中楼、滚动懒加载和 SPA 页面切换。
- 使用远端 UID 黑名单和独立关键词规则，同时保留本地白名单。
- 提供批量上报队列和 GitHub Issue 审核流程。

当前脚本版本：`1.5.11`

## 目录

- [功能](#功能)
- [工作原理](#工作原理)
- [安装](#安装)
- [使用](#使用)
- [屏蔽规则](#屏蔽规则)
- [数据文件](#数据文件)
- [众包上报](#众包上报)
- [配置项](#配置项)
- [隐私与安全](#隐私与安全)
- [开发](#开发)
- [已知限制](#已知限制)
- [贡献](#贡献)
- [许可证](#许可证)

## 功能

- 覆盖 B 站主评论区与楼中楼回复。
- 兼容滚动加载、展开楼中楼、SPA 切换视频后的重新渲染。
- 优先使用稳定的 `data-*` 属性，例如 `data-user-profile-id`、`data-mid`、`data-id`。
- 支持新版 Web Component + open Shadow DOM 评论区，也保留旧版 `.reply-item` / 移动端 `.comment-item` 兜底。
- 远端 UID 黑名单支持缓存、ETag、增量合并、可配置更新间隔和离线模式。
- 独立 `keywords.json` 支持昵称关键词和评论正文关键词。
- 本地白名单优先级最高。
- 提供“已屏蔽肥鱼”筛选视图，楼中楼命中时带出父评论作为上下文。
- 提供左下角待上报面板，支持勾选多条后一次提交；URL 过长时自动拆成多个分片链接。
- 实验性本地文本模型：手动加载、名称旁红底标记、可切换为折叠进筛选。
- 设置面板只有文字和开关，没有动画、声音、emoji 或图形化装饰。
- 调试日志仅写入本地控制台。

## 工作原理

脚本在页面内按以下顺序处理评论：

```text
1. 本地白名单
     命中 -> 放行

2. 远端 UID 黑名单
     命中 -> 隐藏，计入“黑名单”

3. 独立关键词规则
     昵称或评论正文命中 -> 隐藏，计入“关键词”

4. 启发式规则（可关闭）
     头像指纹 / 本地昵称关键词 / 固定话术 / 短时高频 / 模板同文
     达到阈值 -> 隐藏，计入“规则”

5. 本地模型钩子（可选，默认关闭）
     只在页面内调用用户注册的分类器，不联网
     返回 block -> 隐藏，计入“本地模型”

6. 上报入口
     只对未自动屏蔽的评论显示
```

所有隐藏、恢复、统计和日志都只发生在当前页面和本地存储中。脚本不会调用 B 站接口，也不会替用户执行任何账号操作。

## 安装

### 桌面端

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开下面的 Raw 地址安装脚本：

   ```text
   https://raw.githubusercontent.com/OrO-c/pkillFish/main/pkillFish.user.js
   ```

   如果 GitHub Raw 缓存了旧版本，可以使用：

   ```text
   https://cdn.jsdelivr.net/gh/OrO-c/pkillFish@main/pkillFish.user.js
   ```

3. 打开任意 B 站视频、动态或专栏页面，等待评论区加载。
4. 右下角出现 `pf` 按钮后，点击打开设置面板。

### 移动端

支持 Kiwi Browser、Firefox Android 等可以安装 Tampermonkey / Violentmonkey 的浏览器。新版 B 站 Web Component 评论区使用 open Shadow DOM；旧版移动端 DOM 会走兼容分支。

### 更新

脚本通过 `@updateURL` / `@downloadURL` 检查更新。也可以在用户脚本管理器中手动重新安装 Raw 地址。

## 使用

### 设置面板

右下角 `pf` 按钮打开面板，包含三个页签：

- `状态`：拦截总数、黑名单/关键词/规则/模型命中数、当前页面统计、今日统计、规则文件版本与更新时间、白名单数量。
- `设置`：功能开关、上报仓库、黑名单地址、关键词地址、更新间隔、规则阈值、关键词、白名单和统计清理。
- `日志`：最近 200 条屏蔽记录，每条可以恢复或加入白名单。

点击面板外部或按 `Esc` 关闭。

### 已屏蔽肥鱼

新版评论区的“最热 | 最新”右侧会显示“已屏蔽肥鱼”按钮。

- 点击进入筛选视图，只显示当前页面中包含屏蔽记录的评论楼。
- 根评论命中时显示整个评论楼。
- 楼中楼命中时显示父评论作为上下文，并隐藏同一楼下未命中的回复。
- 再次点击按钮退出筛选。
- 点击“最热”或“最新”也会退出筛选，并继续执行 B 站排序。
- 顶部提示会显示当前筛选覆盖的记录数，并注明只覆盖已加载到 DOM 的评论。

正常评论区的行为不受筛选视图影响：

- 楼中楼命中时，只隐藏这一条回复，父评论和其他回复保持可见。
- 根评论命中时，隐藏整个 `bili-comment-thread-renderer`，避免出现没有父评论的孤儿回复。

### 批量上报

点击未被自动屏蔽评论下方的“上报可疑鱼”，评论会进入左下角的待上报面板，不会立刻打开 GitHub。

面板支持：

- 勾选或取消单条记录；
- 全选；
- 单条移除；
- 清空整个队列；
- 提交选中记录。

默认一次最多提交 10 条。队列保存在本地 GM 存储中，刷新页面不会丢失。URL 长度允许时，提交后打开一个 GitHub Issue 新建页；如果 URL 过长，会改为弹出一个分片面板：

- 每个分片链接对应一个较小的 Issue；
- 点击分片链接后，该项会加删除线，表示已打开；
- 需要逐个提交所有分片；
- 全部分片处理完后，再手动清空待上报列表；
- 没有超长时不会出现分片面板。

自动屏蔽的评论不会出现上报按钮，也不会进入待上报队列。

### 协作者合并模式

拥有仓库合并权限的协作者，可以在设置中开启：

```text
具有合并权限的报告（强制刷新并复制 JSON）
```

开启后，点击“提交选中”不会打开 GitHub Issue，而是：

1. 强制重新拉取最新的 `blacklist.json`；
2. 把本次勾选的 UID 合并进去；
3. 生成完整、格式化后的 JSON；
4. 自动复制到剪贴板，并显示在一个只读文本框中；
5. 由协作者人工替换仓库里的 `blacklist.json`。

行为细节：

- 已存在的 UID 不重复添加；
- `revoked` 中的 UID 会跳过；
- 有新条目时版本号 +1，并更新 `updatedAt`；
- 没有新条目时只复制最新文件；
- 强制拉取失败会中止，不使用旧缓存；
- 这个开关只是本地便利模式，不会真的授予 GitHub 权限，也不会自动提交文件。

### 实验性本地文本模型

训练样本的正样本定义是：**黑名单账号在 2026-10-01 之后发布的全部评论，不论内容**。采集脚本按这个规则直接写 `positives.jsonl`，不按关键词或话术二次筛选。

实验模型是可选功能，模型文件不随脚本自动加载。它需要用户手动点击“加载本页模型”，切换页面后释放。

- 默认行为：只给模型命中的评论在评论者名称旁加红底文字框“机器学习判定为AI生成”，不隐藏评论。
- 关闭“仅在名称旁标记，不隐藏”后：命中评论折叠进“已屏蔽肥鱼”筛选，但仍保留红底文字框。
- 模型只在当前页面生效，不写入用户状态，不自动下载。
- 模型特征会屏蔽常见模型名称，并移除 `@` 提及和“回复 @某人：”前缀，避免仅凭提及行为误判；已知误判样本会进入训练集并加权。
- 训练对评论文本做长度无关的特征归一化，长评论不会仅因为更长就更容易被判成 AI。
- 自动屏蔽的模型命中评论不显示普通上报按钮，但仍显示“报告误判”按钮。
- 点击“报告误判”会打开一个标题以 `[ml-false-positive]` 开头的 Issue，用于收集负样本，不会自动加入 UID 黑名单。Issue 不依赖仓库预建标签。
- 误判 Issue 关闭为 `completed`，或打上可选的 `ml-false-positive-accepted` 标签后，视为通过；收集脚本会给它 `weight: 3`，训练时权重高于普通负样本。
- 模型地址可以在设置中填写；留空使用主仓库的 `ml/artifacts/model.json`。

误判样本收集：

```bash
python ml/collect_false_positives.py --repo OrO-c/pkillFish
python ml/train_model.py --data ml/data --out ml/artifacts/model.json
```

标签不是必需的。若希望在 GitHub 中方便筛选，可以创建：

```text
ml-false-positive
ml-false-positive-accepted
```

不创建标签也能通过标题和隐藏的 `pkillfish:ml-false-positive` 元数据收集。

默认模型地址是 `https://raw.githubusercontent.com/OrO-c/pkillFish/main/ml/artifacts/model.json`，模型随主仓库发布。同领域负样本采集、训练和模型发布说明见 [ml/README.md](ml/README.md)。

## 屏蔽规则

### UID 黑名单

远端 [blacklist.json](blacklist.json) 保存需要屏蔽的 B 站 UID。命中 UID 时隐藏整条评论或对应楼中楼。

### 关键词规则

独立 [keywords.json](keywords.json) 保存昵称关键词和评论关键词。

- `nameKeywords` 对昵称做字面子串匹配。
- `commentKeywords` 对评论正文做字面子串匹配。
- 不区分大小写，并做 NFKC 规范化。
- 任意一条命中就自动屏蔽，计入“关键词”统计。
- 本地白名单可以覆盖关键词误伤。

默认包含以下具体昵称词（以 [keywords.json](keywords.json) 为准）：

```json
"nameKeywords": ["dsh-agent", "dsh agent", "deepseek harness", "肥鱼", "白饭"]
```

`commentKeywords` 默认为空。默认不包含单独词“大肥鱼”，避免误伤昵称中带有这三个字的普通用户。

### 启发式规则

可在设置中调整：

| 信号 | 默认权重 | 说明 |
| --- | ---: | --- |
| 头像指纹 | 3 | 头像 URL 文件名的 FNV-1a 指纹或原始文件名 |
| 本地昵称关键词 | 3 | 默认关闭，可在设置中启用 |
| 固定话术 | 2 | 本地正则，命中后加分 |
| 短时高频 | 3 | 同一 UID 在当前页面短时间内出现多次 |
| 模板化同文 | 3 | 多个不同 UID 发布完全相同的长文本 |
| 阈值 | 3 | 总分达到阈值才隐藏 |

本地昵称关键词和固定话术默认关闭，避免字面量误伤。UID 黑名单、独立关键词、头像指纹、短时高频和模板同文仍然有效。

### 本地白名单

白名单支持 UID、单条评论标识和指纹。命中白名单的评论不会隐藏，也不会因为远端规则更新而重新隐藏。

## 数据文件

### blacklist.json

```json
{
  "schemaVersion": 1,
  "version": 16,
  "updatedAt": "2026-11-15T00:00:00.000Z",
  "entries": [
    {
      "mid": "123456789",
      "addedAt": "2026-11-15T00:00:00.000Z",
      "reports": [42]
    }
  ],
  "revoked": [],
  "rules": {
    "nicknameKeywords": [],
    "avatarHashes": []
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `mid` | B 站 UID，1-19 位非零开头数字 |
| `addedAt` | 加入黑名单的时间 |
| `reports` | 提供证据的 Issue 编号，去重保存 |
| `revoked` | 需要移除的 UID 墓碑；增量更新不会因远端暂时缺失就删除条目 |
| `rules.nicknameKeywords` | 远端下发的启发式昵称关键词 |
| `rules.avatarHashes` | 远端下发的头像指纹 |

`blacklist.json` 不保存 `reason` 字段。审核理由记录在 `docs/blacklist-changelog.md` 和对应 Issue 中。

### keywords.json

```json
{
  "schemaVersion": 1,
  "version": 1,
  "updatedAt": "2026-11-15T00:00:00.000Z",
  "nameKeywords": ["dsh-agent", "dsh agent", "deepseek harness", "肥鱼", "白饭"],
  "commentKeywords": []
}
```

关键词规则与 UID 黑名单完全分离。关键词文件由远端内容整体替换，删除关键词后下一次更新即生效。

实验模型是单独文件，不放在 `blacklist.json` 或 `keywords.json` 中；默认从主仓库的 `ml/artifacts/model.json` 拉取，详见 [ml/README.md](ml/README.md)。

### 更新与缓存

- 首次启动或缓存过期时请求远端规则。
- 请求带 `If-None-Match` / ETag，304 时只更新检查时间。
- UID 黑名单与本地缓存做并集合并，`revoked` 中的 UID 会被删除。
- 关键词文件按远端内容整体替换。
- 请求失败时保留旧缓存，不影响离线使用。
- 离线模式完全跳过请求，只使用 GM 存储中的缓存。
- 默认更新间隔为 12 小时，可在面板中调整。
- “更新黑名单/关键词”按钮会同时更新两个规则文件。

本地存储键：

```text
pf:v1:state
pf:v1:blacklist
pf:v1:blacklist-meta
pf:v1:keywords
pf:v1:keywords-meta
```

如果用户脚本管理器不提供 GM 存储，会退化为 `localStorage`。

## 众包上报

### 流程

```text
点击“上报可疑鱼”
      |
      v
进入左下角待上报队列
      |
      v
勾选记录 -> 一次提交
      |
      v
打开一个 GitHub Issue 新建页
      |
      v
维护者审核
      |
      +-- resolved / close completed --> workflow 写入 blacklist.json
      |
      +-- wontfix / close not planned --> 不写入
```

提交 Issue 不会自动加入黑名单，必须经过维护者审核。

### Issue 格式

脚本支持两种格式：

- 旧版单条 `pkillfish:meta` 隐藏区块；
- 批量 `pkillfish:batch` JSON 隐藏区块 + 可读表格。

批量格式示例：

```markdown
<!-- pkillfish:batch
[{"mid":"123456789","rpid":"111","link":"https://www.bilibili.com/video/BV..."}]
-->

| # | UID | 昵称 | 评论链接 | 摘要 |
|---|---|---|---|---|
| 1 | `123456789` | 示例用户 | [打开](https://www.bilibili.com/video/BV...) | 评论摘要 |
```

摘要用于控制 URL 长度，完整评论通过链接查看。批量 Issue 默认最多 10 条。

手动创建 Issue 时，请填写昵称、评论链接和评论原文，否则关键词检查无法完成，workflow 会拒绝处理。

### 审核与自动处理

- Issue 创建时由模板添加 `report` 标签；这次 `labeled` 事件通常会显示为 skipped，这是正常现象。
- 维护者给 Issue 打 `resolved`，或关闭为 `completed`：批准写入黑名单。
- 维护者给 Issue 打 `wontfix`，或关闭为 `not planned`：拒绝写入。
- 没有 write / maintain / admin 权限的用户触发上述操作时，workflow 会跳过。
- 写入前会重新校验 `blacklist.json`、`keywords.json` 和 Issue 内容。
- 任意一条 UID 命中 `revoked` 或当前关键词规则，整批拒绝，不做部分写入。
- 一个 Issue 可以包含多条 UID；重复 UID 会自动合并。
- 变更会同时写入 `blacklist.json` 和 `docs/blacklist-changelog.md`。
- 不同 Issue 可以并行处理；同一 Issue 的事件串行处理。推送冲突时会重置到最新 `main`，重新应用本 Issue 后重试。

## 配置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用屏蔽 | 开 | 关闭后新评论不再隐藏 |
| 启用规则扫描 | 开 | 关闭后仍使用 UID 黑名单和独立关键词 |
| 启用本地关键词规则 | 关 | 旧版本地昵称关键词/固定话术，默认关闭 |
| 启用独立关键词屏蔽 | 开 | 使用 `keywords.json` |
| 启用实验性模型 | 开 | 不自动加载模型，需手动点击加载 |
| 仅在名称旁标记 | 开 | 关闭后模型命中评论折叠进“已屏蔽肥鱼” |
| 模型地址 | 空 | 留空使用主仓库的 `ml/artifacts/model.json`；必须是 HTTPS |
| 离线模式 | 关 | 跳过远端请求，只使用缓存 |
| 显示“上报可疑鱼”按钮 | 开 | 关闭后移除所有上报按钮 |
| 具有合并权限的报告 | 关 | 强制拉取最新黑名单并复制完整 JSON，不打开 Issue |
| 调试日志 | 关 | 仅写本地 `console.debug` |
| 启用本地轻量模型钩子 | 关 | 调用本机注册的分类器，不联网 |
| 上报仓库 | `OrO-c/pkillFish` | 支持 `owner/repo` 或 GitHub URL |
| 黑名单地址 | 空 | 留空使用项目默认 `blacklist.json`，必须是 HTTPS |
| 关键词地址 | 空 | 留空使用项目默认 `keywords.json`，必须是 HTTPS |
| 更新间隔 | 12 小时 | 0.25-720 小时 |
| 拦截阈值 | 3 | 1-12 |
| 高频条数 / 窗口 | 8 条 / 10 分钟 | 同一 UID 在当前页面 |
| 本地昵称关键词 | 三个具体词 | 每行一个，仅在本地关键词规则开启时生效 |
| 固定话术 | 三条默认正则 | 每行一个，仅在本地关键词规则开启时生效 |
| 头像指纹 | 空 | 每行一个文件名或 FNV-1a 指纹 |
| 白名单 | 空 | UID / 单条评论 / 指纹，优先级最高 |

## 隐私与安全

- 脚本不读取 Cookie、账号凭据、私信或其他隐私数据。
- 脚本不调用 B 站 API，也不执行自动举报、自动拉黑或自动关注。
- 所有屏蔽、恢复、统计和日志均只在本地进行。
- 待上报队列保存在本地，只有用户点击提交时才打开 GitHub。
- GitHub Issue 是公开的；提交前请只包含公开评论区信息，不要附上账号凭据、Cookie、个人隐私或私信截图。
- 本地模型钩子只在页面内调用，脚本自身不向任何模型 API 发送请求。
- 实验模型文件只在用户点击加载时从配置的 HTTPS 地址拉取；原始训练样本不会随模型发布。
- 远端规则文件是公开数据；本地白名单是用户自己的最终否决权。

## 开发

### 环境

- Node.js 20+
- 无运行时依赖
- 无构建步骤，脚本本身是单文件用户脚本

### 命令

```bash
npm test                 # 单元测试
npm run validate         # 校验 blacklist.json
npm run validate:keywords # 校验 keywords.json
npm run check            # 语法 + 两个规则文件 + 全部测试

# Python 实验模型工具链（需要自行安装 ml/requirements.txt）
python ml/scrape_aicu.py --help
python ml/scrape_video.py --help
python ml/train_model.py --help
```

### 项目结构

```text
.
├── pkillFish.user.js
├── blacklist.json
├── keywords.json
├── package.json
├── LICENSE
├── README.md
├── docs/
│   └── blacklist-changelog.md
├── scripts/
│   ├── apply-report.mjs
│   ├── validate-blacklist.mjs
│   ├── validate-keywords.mjs
│   └── lib/
│       ├── blacklist.mjs
│       ├── keywords.mjs
│       └── report-parser.mjs
├── tests/
│   ├── blacklist.test.mjs
│   ├── keywords.test.mjs
│   └── report.test.mjs
├── ml/
│   ├── scrape_aicu.py
│   ├── scrape_video.py
│   ├── train_model.py
│   ├── requirements.txt
│   ├── data/
│   ├── artifacts/
│   └── README.md
└── .github/
    ├── ISSUE_TEMPLATE/
    │   └── report-fish.md
    └── workflows/
        ├── auto-blacklist.yml
        └── validate-blacklist.yml
```

### 规则文件约定

- `blacklist.json` 只保存 UID、加入时间、证据 Issue 和墓碑。
- `keywords.json` 只保存昵称关键词和评论关键词。
- 两个文件都经过严格校验，未知字段、非法 UID、非法时间和超过上限的内容会被拒绝或忽略。
- 新增规则后运行 `npm run check`，并确保 CI 通过。

## 已知限制

- 只能处理当前页面已经加载到 DOM 的评论；B 站没有加载出来的评论不会被凭空显示。
- “已屏蔽肥鱼”筛选视图同样只覆盖已经加载的评论。
- B 站评论区结构变化可能导致选择器失效，需要更新脚本。
- 关键词是字面量子串匹配，范围过宽时可能误伤普通用户；本地白名单可以兜底。
- 短时高频规则只能统计当前页面，不能跨视频或跨账号统计。
- GitHub Raw 可能缓存旧文件；安装或更新时可使用 jsDelivr 地址。
- 实验模型是辅助信号，受训练样本和阈值影响，不能保证零误判；误判时使用日志恢复或白名单。
- 模型文件和训练数据分开管理：模型随主仓库发布，原始训练样本不提交。
- 本脚本不提供账号安全、封禁或举报功能。

## 贡献

欢迎提交 Issue 和 Pull Request。

- 误伤反馈请提供 UID、评论链接和必要的上下文，不要提交隐私数据。
- 新增黑名单 UID 请通过上报流程或直接修改 `blacklist.json`，并说明证据。
- 新增关键词请修改 `keywords.json`，并说明匹配范围。
- 提交代码前运行 `npm run check`。
- 涉及规则解析、workflow 或数据格式的改动，请同时更新测试和文档。

## 许可证

本项目使用 [MIT License](LICENSE)。

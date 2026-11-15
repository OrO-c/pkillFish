# pkillFish

静默、低干扰的 B 站 DSH / 大肥鱼 Agent 评论净化工具。它只做一件事：在你自己的浏览器里，把不想看的评论安静地隐藏掉。

> 本工具不调用 B 站 API，不自动举报，不拉黑账号，不修改 B 站服务器上的任何数据。
> 它不是“反 AI”工具，也不是用来给具体的人贴标签的工具。它只是一个本地内容过滤器。

## 命名：`pkill` 的 neta

`pkill` 是 Linux/Unix 的进程管理命令，按名字或命令行模式向进程发送信号。常见的用法是：

```sh
pkill -f dsh-dafeiyu
pkill -f 'fish.*agent'
```

`pkillFish` 借用了这个命名：

- 它像 `pkill` 一样，按“特征”找到目标，然后让目标从你的视野里退出；
- 它发送的是 `SIGTERM` 而不是 `SIGKILL`：隐藏是可恢复的，随时可以从日志里“恢复”或加入白名单；
- 它不需要 root，不做系统级操作，只在你自己的浏览器 DOM 里工作；
- 默认没有输出。只有你打开面板，才会看到它做过什么。

真正的 `pkill` 管理的是操作系统进程，`pkillFish` 管理的是评论区的渲染节点。名字是玩梗，行为是克制的。

## 和常见“大肥鱼清除插件”的区别

| 维度 | pkillFish | 带动画 / 玩梗向的同类工具 |
| --- | --- | --- |
| 视觉 | 黑白灰、纯文字、无图标、无动画 | 鱼/鲸鱼形象、弹幕特效、彩蛋 |
| 提醒 | 默认完全静默，不弹窗、不通知 | 拦截时弹提示、计数动画 |
| 数据来源 | GitHub 托管 UID 黑名单 + 独立关键词 JSON + 本地轻量规则 | 常常依赖 B 站 API 或模型 API |
| 上报 | 用户点击按钮后才打开 GitHub Issue | 可能自动上报或自动举报 |
| 账号操作 | 无 | 可能批量拉黑、举报 |
| 误判处理 | 日志逐条恢复、本地白名单优先 | 往往只能关插件或换号 |
| 设计参照 | uBlock Origin 的“功能优先” | 桌宠 / 游戏化面板 |

pkillFish 不追求“把鱼杀光”的爽感。它追求的是：日常刷 B 站时，评论区安静一点，而你不知道它存在。

## 功能

- 覆盖 B 站主评论区与楼中楼回复。
- 兼容滚动懒加载、展开楼中楼、SPA 切换视频后重新渲染。
- 优先读取稳定的 `data-*` 属性（如 `data-user-profile-id`、`data-mid`、`data-id`），不依赖易变的 class。
- 支持新版 Web Component + open Shadow DOM 评论区，也保留旧版 `.reply-item` / 移动端 `.comment-item` 兜底。
- 远端 UID 黑名单缓存、ETag 条件请求、增量合并、可配置更新间隔、离线模式。
- 独立的 `keywords.json`：昵称或评论正文命中关键词即自动屏蔽；关键词命中属于自动屏蔽，不显示上报按钮。
- 本地白名单优先级高于远端黑名单。
- 每条评论的操作区有低调的“上报可疑鱼”文字按钮；点击后加入左下角待上报面板，不会立刻联网。
- 待上报面板支持勾选多条、一次提交到一个 Issue；默认单批最多 10 条。
- Issue 支持 `pkillfish:batch` 批量格式，维护者可以在一张表里审阅多条 UID / 链接 / 摘要；旧的单条 `pkillfish:meta` 格式继续兼容。
- 评论筛选区新增“已屏蔽肥鱼”按钮，紧挨“最热 | 最新”，只显示本页被屏蔽的评论；楼中楼命中时会把父评论一起带出来作为上下文。
- 设置面板只有文字和开关：没有动画、没有声音、没有 emoji、没有鱼。
- 调试日志只写到本地控制台，不发送到任何地方。

## 安装

### 桌面端

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 新建脚本，粘贴 `pkillFish.user.js` 的全部内容；或直接打开 Raw 安装地址：

   ```text
   https://raw.githubusercontent.com/OrO-c/pkillFish/main/pkillFish.user.js
   ```
3. 打开任意 B 站视频、动态或专栏页面，评论区加载后右下角会出现一个很小的 `pf` 按钮。
4. 点击 `pf` 打开面板。默认已经启用屏蔽、独立关键词和规则扫描；关键词列表默认只含三个具体昵称词。

脚本也注册了油猴菜单命令：

- `pkillFish 设置面板`
- `pkillFish 立即扫描`

### 移动端

支持安装了用户脚本管理器的手机浏览器，例如 Kiwi Browser + Tampermonkey、Firefox for Android + Tampermonkey/Violentmonkey。

B 站移动网页版有时会把评论入口限制在 App 内。这种情况下页面本身没有评论 DOM，脚本不会凭空生成评论，也不会绕过限制。可以尝试：

- 在手机浏览器里请求桌面版网站；
- 使用仍会渲染评论的页面（视频、动态、专栏）；
- 用 Kiwi 的桌面模式配合桌面版 B 站。

脚本对移动端旧版评论结构（`.comment-item`、`[data-comment-id]`、`data-mid`）做了兜底，逻辑与桌面端共用。

## 使用

默认行为：静默运行。不会主动弹窗、不会发通知、不会在控制台输出（除非打开调试日志）。

面板只有三个页签：

- `状态`：拦截总数、黑名单/关键词/规则/模型命中数、本次页面、今日、黑名单与关键词条目数、最后更新时间、白名单数量、更新按钮。
- `设置`：开关、上报仓库、黑名单地址、关键词地址、更新间隔、阈值、本地昵称关键词、固定话术、头像指纹、白名单、清空统计/日志。
- `日志`：最近 200 条被屏蔽记录；每条可以“恢复”或“加入白名单”。

点击面板外部或按 `Esc` 关闭面板。

### 已屏蔽肥鱼筛选

新版评论区的“最热 | 最新”右侧会多出一个文字按钮：

```text
最热   最新   已屏蔽肥鱼
```

点击后进入本地筛选视图：

- 只显示当前页面中包含屏蔽记录的评论楼；
- 如果命中项是楼中楼，会把它的父评论一起显示出来作为上下文；
- 同一楼下其他未命中的楼中楼在筛选视图里隐藏，避免干扰；
- 顶部显示“已屏蔽肥鱼：本页 N 条”的朴素提示；
- 再次点击按钮退出筛选；点击“最热”或“最新”也会自动退出筛选，并继续执行 B 站排序。
- 筛选只覆盖当前已经加载到 DOM 的评论。B 站没有加载出来的评论不会被凭空显示；顶部提示会写明“本页 N 条（仅当前已加载评论）”。

正常评论区不受筛选视图影响：

- 楼中楼命中时，只隐藏这一条回复，父评论和同一楼下的其他楼中楼保持可见；
- 根评论命中时，仍按原有逻辑隐藏整个 `bili-comment-thread-renderer`，避免留下没有父评论的孤儿回复；
- 筛选只修改本地 DOM，不调用 B 站 API、不新增日志、不改变统计计数。

筛选视图使用当前页面已经渲染和被屏蔽的记录；滚动懒加载到的新评论会自动进入筛选结果。旧版评论区和移动端旧 DOM 没有这个新版筛选按钮，仍保持原有屏蔽逻辑。

## 屏蔽链路

严格按下面的顺序执行，前一步命中后不会继续执行后面的逻辑：

```text
1. 本地白名单
     命中 -> 直接放行（优先级高于远端黑名单）

2. 远端 UID 黑名单
     命中 UID -> 隐藏 DOM，计入“黑名单”统计

3. 独立关键词规则（keywords.json，默认启用）
     昵称命中 nameKeywords，或评论正文命中 commentKeywords
     -> 隐藏 DOM，计入“关键词”统计

4. 轻量规则（可关闭）
     头像指纹 / 本地昵称关键词 / 固定话术 / 短时高频 / 模板化同文
     加权分数达到阈值 -> 隐藏 DOM，计入“规则”统计

5. 本地轻量模型钩子（可选，默认关闭）
     仅调用本机注册的 classifier，不联网
     返回 block -> 隐藏 DOM，计入“本地模型”统计

6. 上报按钮
     只给未被自动屏蔽的评论注入；自动屏蔽的评论没有上报按钮
     上报只加入本地待上报面板，用户点击提交后才打开 GitHub
```

白名单优先是有意为之：社区黑名单可能有误伤，用户必须有最终否决权。

### 规则权重与阈值

默认值：

| 信号 | 权重 | 说明 |
| --- | --- | --- |
| 头像指纹 | 3 | 头像 URL 文件名的 8 位 FNV-1a 哈希或原始文件名 |
| 昵称关键词 | 3 | 不区分大小写的子串匹配 |
| 固定话术 | 2 | 本地正则，命中一条即加 2 分 |
| 短时高频 | 3 | 同一 UID 在当前页面短时间内出现 N 条 |
| 模板化同文 | 3 | 至少 3 个不同 UID 发布完全相同的长文本 |
| 阈值 | 3 | 总分达到 3 才隐藏 |

因此：

- 昵称、头像、高频、模板同文，任意一个强信号单独即可触发；
- 固定话术单独命中不够，需要再叠加一个信号；
- 1.1.2 起默认不再包含单独词“大肥鱼”：它会把昵称里带这三个字的普通用户误判成 Agent。默认只保留“dsh-agent”“dsh agent”“deepseek harness”这类更具体的词。
- 1.1.3 起**本地昵称/话术规则默认关闭**：避免字面量误伤。独立 `keywords.json` 是另一条链路，默认启用但初始列表为空；UID 黑名单、头像指纹、短时高频、模板同文仍然有效。
- 需要临时启用关键词规则时，打开面板 →“启用关键词规则（昵称/话术）”；如果连规则扫描都不想要，关闭“启用规则扫描”即可退化为纯 UID 黑名单模式。
- 高频规则只统计发布时间落在窗口内的评论；页面上几年前的历史评论不会被当成“刚刚刷屏”。时间无法解析时，高频规则不参与，但模板同文仍可触发。

这些值都可以在面板里调整。改完点击“保存设置”，已有评论会重新评估。

### 独立关键词屏蔽（keywords.json）

关键词规则和 UID 黑名单是**两个独立文件**：

- `blacklist.json`：只记 UID；
- `keywords.json`：只记名称或评论关键词。

关键词文件格式：

```json
{
  "schemaVersion": 1,
  "version": 1,
  "updatedAt": "2026-11-15T00:00:00.000Z",
  "nameKeywords": ["示例昵称关键词"],
  "commentKeywords": ["示例评论关键词"]
}
```

规则：

- `nameKeywords` 对昵称做字面量子串匹配；
- `commentKeywords` 对评论正文做字面量子串匹配；
- 不区分大小写，会做 NFKC 规范化；
- 任意一条命中就自动屏蔽，计入“关键词”统计；
- 本地白名单优先级最高，可以覆盖关键词误伤；
- 默认 `nameKeywords` 只包含 `dsh-agent` / `dsh agent` / `deepseek harness` 三个具体词，不包含单独词“大肥鱼”；`commentKeywords` 默认为空，按需添加；
- 关键词命中与 UID 黑名单命中一样，属于自动屏蔽，**不会出现“上报可疑鱼”按钮**；
- 如果用户绕过界面强行提交 Issue，workflow 会在写入前读取仓库当前的 `keywords.json` 再检查一次：昵称或评论摘要命中就拒绝整批；关键词列表非空但 Issue 缺少昵称/评论内容时也会拒绝，避免绕过检查。

关键词地址可以在面板设置里修改；留空使用项目默认的 `keywords.json`。更新按钮会同时更新 UID 黑名单和关键词文件。

### 头像“哈希”说明

脚本不会下载头像，也不会做图片识别。它取头像 URL 的文件名部分（例如 `10fbeb...jpg`），计算一个 32 位 FNV-1a 十六进制指纹。这样：

- 不产生额外网络请求；
- 同一张头像在不同尺寸参数下仍能匹配；
- 不能识别“换了一张相似图”的情况。

需要更复杂的感知哈希时，应通过本地模型钩子实现，而不是让脚本偷偷下载图片。

## 黑名单

默认地址：

```text
https://raw.githubusercontent.com/<owner>/pkillFish/main/blacklist.json
```

可以在设置里覆盖为任意 HTTPS 地址。脚本只会发起这一条只读请求，使用 `GM_xmlhttpRequest`（不可用时退化为 `fetch`），不携带 Cookie。

### 文件格式

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
    "nicknameKeywords": ["dsh-agent", "deepseek harness"],
    "avatarHashes": []
  }
}
```

字段说明：

- `mid`：B 站 UID，也是用户 mid。1-19 位数字，不允许 0 开头。
- `reports`：补充证据的 Issue 编号，去重。
- `revoked`：需要从黑名单删除的 UID。增量更新不会因为远端暂时缺失就删条目，删除必须通过 `revoked` 显式声明。
- `rules.nicknameKeywords`：远端下发的昵称关键词，只做字面量子串匹配，不接受正则。
- `rules.avatarHashes`：远端下发的头像指纹，只接受文件名安全字符。

远端也支持纯文本名单，每行一个 UID；行尾注释只用于阅读，不会写入 JSON：

```text
123456789
987654321 # 仅注释，不写入 JSON
```

### 更新机制

- 首次启动或缓存过期时请求远端；
- 带 `If-None-Match` / ETag，304 时只更新检查时间；
- UID 黑名单远端条目与本地缓存做并集合并，新条目覆盖旧原因；关键词文件按远端内容整体替换，删除关键词即可解除；
- `revoked` 里的 UID 会从结果中删除；
- 请求失败保留旧缓存，不影响离线使用；
- 离线模式完全跳过请求，只使用 GM 存储中的缓存；
- 默认间隔 12 小时，可在面板改到 0.25-720 小时；更新按钮会同时更新 UID 黑名单和关键词。

本地缓存位于 GM 存储：

```text
pf:v1:blacklist
pf:v1:blacklist-meta
pf:v1:keywords
pf:v1:keywords-meta
```

如果用户脚本管理器没有 GM 存储，会退化为 `localStorage`。

## 众包上报

未被自动屏蔽的评论操作区会插入一个灰色小字按钮；命中 UID 黑名单、关键词或规则而被自动屏蔽的评论不会出现这个按钮：

```text
上报可疑鱼
```

它不会自己提交任何东西。点击后：

1. 读取该评论的 UID、rpid、页面链接、评论原文（尽量从 DOM 和页面组件数据中获取）；
2. 拼出一个 GitHub Issue 新建页 URL；
3. 用 `GM_openInTab` 打开新标签页；不可用时退回 `window.open`；
4. 由用户在 GitHub 页面确认内容、附截图、点击提交。

提交 Issue 本身不会自动加入黑名单。维护者审核后：

- 打上 `resolved`，或把 Issue 关闭为 **completed**：workflow 才写入黑名单；
- 打上 `wontfix`，或把 Issue 关闭为 **not planned**：只回复并关闭，不改名单。

Issue 会预填：

- B 站 UID / mid；
- 评论永久链接（形如 `https://www.bilibili.com/video/BV.../#reply<rpid>`）；
- 评论完整原文；
- `pkillfish:meta` 隐藏区块，供自动化解析；
- 截图提示与隐私确认清单。

如果 B 站改版导致无法拿到 rpid，链接会退化为页面链接，Issue 正文会保留手动补充提示。

GitHub 的 Issue 新建页通过 URL 接收正文，而 URL 有长度限制。脚本会优先保留完整原文；极端长的评论会被逐级截断，并在正文里明确提示“请手动补充完整原文”。正常长度的 B 站评论通常不受影响。

脚本不强制使用 Issue 模板查询参数，而是直接把正文放进 `body`，避免模板覆盖预填内容。本项目 `.github/ISSUE_TEMPLATE/config.yml` 允许空白 Issue；如果你把上报仓库切换到自己的仓库，请确保该仓库没有禁用 blank issue，否则 GitHub 可能忽略 `body` 预填。

上报仓库默认是 `OrO-c/pkillFish`，可以在设置里改成任意 `owner/repo` 或 GitHub URL。如果你 fork 或迁移了仓库，记得同步修改脚本顶部的 `DEFAULT_REPORT_REPO`。

### 批量上报面板

评论区肥鱼密集时，逐条开 Issue 很麻烦。现在点击“上报可疑鱼”只会把评论加入左下角的“待上报评论”面板：

- 每条记录显示 UID、昵称、原文摘要和“打开评论”；
- 每条前面有勾选框，默认选中；
- 可以逐条移除，也可以“全选”；
- 只有勾选了至少一条，才允许提交；没有勾选不会打开任何页面；
- 一次默认最多提交 10 条，超过会提示减少勾选；
- 提交时只打开一个 GitHub Issue 新建页，不会自动提交；
- 队列保存在本机 GM 存储，刷新页面不会丢；
- 提交后队列不会自动清空，确认 Issue 已提交后再点“清空”。

批量 Issue 使用隐藏的 `pkillfish:batch` JSON 区块加一张可读表格：

```text
| # | UID | 昵称 | 评论链接 | 摘要 |
```

摘要为节选，完整评论请点链接。这样既控制 URL 长度，也方便维护者逐条打开核对。单批最多 10 条；更多评论请分批提交。

隐私提醒：GitHub Issue 是公开的。只提交公开评论区信息，不要附上 Cookie、账号凭据、私信或任何个人隐私。

## GitHub 自动化流程

一个 Issue 可以包含多条上报；`resolved` / `wontfix` 标签，或 Issue 的关闭原因，控制整个流程：

```text
Issue 创建（report 标签）
        |
        v
维护者审核
        |
        +-- 打 resolved / Close as completed
        |      |
        |      v
        |   校验打标签者权限（write / maintain / admin）
        |      |
        |      v
        |   解析 pkillfish:meta
        |      |
        |      v
        |   严格校验 UID / 链接 / 原文 / 现有 blacklist.json
        |      |
        |      v
        |   追加或补充 reports
        |      |
        |      v
        |   再次校验 -> 写 blacklist.json + 变更日志
        |      |
        |      v
        |   提交并推送到 main
        |      |
        |      v
        |   回复结果 -> 关闭 Issue
        |
        +-- 打 wontfix / Close as not planned
               |
               v
            不修改黑名单 -> 回复说明 -> 关闭 Issue
```

### 防脏数据与防刷

- 只有对仓库有 `write` / `maintain` / `admin` 权限的操作者打标签或关闭 Issue 才会触发流程；`triage` 权限不够。
- Issue 必须带有 `report` 标签（上报模板会自动添加），避免把普通讨论误送进自动化。
- Issue 正文通过环境变量传入 Node 脚本，不拼接进 shell 命令。
- 严格解析隐藏的 `pkillfish:meta` 单条区块或 `pkillfish:batch` 批量区块；任意一条 UID / 链接不合法就拒绝整批，避免部分写入。
- 写入前读取当前 `keywords.json`：昵称或评论摘要命中关键词规则就拒绝整批；关键词列表非空而 Issue 缺少昵称/评论内容时也拒绝，避免绕过界面检查。
- `keywords.json` 由 `scripts/validate-keywords.mjs` 在 CI 中校验。
- 链接必须是 `www.bilibili.com`、`m.bilibili.com` 或 `t.bilibili.com` 的评论页；`space.bilibili.com` 只用于兜底提取 UID，不能作为评论链接。
- 评论原文不能为空，不能是模板占位符。
- 写入前重新校验整份 `blacklist.json`：重复 UID、非法字段、`revoked` 冲突、超大文件都会失败。
- `revoked` 中的 UID 不会被自动重新加入，必须人工处理。
- 同一个 Issue 的多个事件用 `concurrency` 串行；不同 Issue 允许并行。推送冲突时，失败的任务会重置到最新 `main`，重新应用本 Issue，再重试推送，避免 GitHub 全局并发组取消合法的其他 Issue。
- 一个 Issue 可以包含多条 UID；任意一条非法（包括在 `revoked` 中）都会拒绝整批，不做部分写入。
- Issue 创建时模板会自动加 `report` 标签，这也会触发一次 `labeled` workflow，但 `authorize` 会把它跳过。这个 skipped run 是正常的，不代表流程失败。
- 关闭 Issue 时：`completed` 视为通过，`not planned` 视为不通过；如果关闭人没有 write/maintain/admin 权限，会自动跳过。
- 如果关闭多个 Issue 时看到 `Canceling since a higher priority waiting request`，那是旧版全局并发组的行为；新版已改成按 Issue 分组，正常情况下不会再互相取消。
- 失败时不提交、不关闭 Issue，并回复失败原因。

### 启用步骤

1. 把仓库的 `blacklist.json`、`pkillFish.user.js`、`scripts/`、`.github/` 推到 `main`。
2. 仓库 Settings -> Actions -> General -> Workflow permissions 选择 **Read and write permissions**。
3. 创建标签：

```sh
gh label create report   --color 5319e7 --description "社区上报，等待审核"
gh label create resolved --color 0e8a16 --description "审核通过，加入黑名单"
gh label create wontfix  --color d93f0b --description "不加入黑名单"
```

4. 确认 `.github/ISSUE_TEMPLATE/report-fish.md` 存在。
5. 可选：给 `main` 配置分支保护。默认流程是直接推送到 `main`；如果开启保护，需要允许 `pkillFish-bot` 绕过，或把 workflow 改成创建 PR + auto-merge。

### 变更日志

`docs/blacklist-changelog.md` 由 workflow 自动追加，记录日期、操作、UID、Issue 与理由。黑名单每次变更都会同时更新 `version` 和 `updatedAt`。

### 仓库地址

本项目默认指向 `OrO-c/pkillFish`：

- 脚本顶部的 `DEFAULT_REPORT_REPO`；
- metadata 中的 `@namespace` / `@homepageURL` / `@supportURL` / `@updateURL` / `@downloadURL`；
- `.github/ISSUE_TEMPLATE/config.yml` 的 contact URL；
- README 中的示例地址。

如果你 fork 或迁移到其他账号，需要同步修改以上位置。只改 `DEFAULT_REPORT_REPO` 时，黑名单和关键词地址会自动跟着变化；但 Issue 模板、支持链接和脚本更新地址不会自动变。

## 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用屏蔽 | 开 | 关闭后新评论不再隐藏；已隐藏的可在日志恢复 |
| 启用规则扫描 | 开 | 关闭后仍使用 UID 黑名单和独立关键词 |
| 启用关键词规则 | 关 | 本地昵称关键词/固定话术；默认关闭，避免字面量误伤 |
| 启用独立关键词屏蔽 | 开 | 使用 keywords.json 的昵称/评论关键词；默认仅三个具体昵称词 |
| 离线模式 | 关 | 完全跳过远端请求，只用本地缓存 |
| 显示“上报可疑鱼”按钮 | 开 | 关闭后移除所有上报按钮 |
| 调试日志 | 关 | 仅 `console.debug`，不上传 |
| 启用本地轻量模型钩子 | 关 | 见下文扩展接口 |
| 上报仓库 | `OrO-c/pkillFish` | 支持 `owner/repo` 或 GitHub URL |
| 黑名单地址 | 空 | 留空使用项目默认 UID 黑名单；必须是 HTTPS |
| 关键词地址 | 空 | 留空使用项目默认 keywords.json；必须是 HTTPS |
| 更新间隔 | 12 小时 | 0.25-720 |
| 拦截阈值 | 3 | 1-12 |
| 高频条数 / 窗口 | 8 条 / 10 分钟 | 同一 UID 在当前页面 |
| 昵称关键词 | 见默认值 | 每行一个 |
| 固定话术 | 见默认值 | 每行一个正则 |
| 头像指纹 | 空 | 每行一个文件名或 8 位哈希 |
| 白名单 UID | 空 | 每行一个，优先级最高 |

## 本地模型扩展接口

当前版本不内置任何模型，也不会自动向 DSH、DeepSeek 或其他第三方 API 发请求。需要本地分类器时，在页面里注册一个同步或异步函数：

```js
// 在 Tampermonkey 的另一个脚本、浏览器控制台，或本脚本的扩展版本中。
// 在油猴沙箱里优先通过 unsafeWindow 取页面上的接口；页面控制台直接用 window。
const api = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).pkillFish;
api.registerClassifier(async (comment) => {
  // comment: { mid, uname, text, avatar, rpid, pageUrl }
  // 只做本地判断；不要在这里发网络请求。
  const suspicious = await myLocalModel(comment.text);
  return suspicious ? { block: true, reason: 'local-model' } : false;
});
```

然后在面板里打开“启用本地轻量模型钩子”。

约束：

- 钩子只在黑名单和规则都没有命中时才会被调用；
- 默认超时 500ms（可在设置存储中调整 `modelTimeoutMs`，面板暂未暴露）；
- 钩子抛异常只会写调试日志，不会影响页面；
- 脚本自身不包含模型、不下载模型、不发起模型请求。

## 兼容性与 DOM 细节

2026 年 11 月实测，B 站新版评论区是多层 Web Component：

```text
<bili-comments>（open shadow root）
  #feed
    <bili-comment-thread-renderer>（open shadow root）
      <bili-comment-renderer id="comment">（open shadow root）
        #user-avatar[data-user-profile-id]
        bili-comment-user-info（shadow: #user-name[data-user-profile-id]）
        bili-rich-text（shadow: #contents）
        bili-comment-action-buttons-renderer（shadow: #more / #reply）
      <bili-comment-replies-renderer>（open shadow root）
        <bili-comment-reply-renderer>（open shadow root）
```

脚本的处理方式：

- 不假设 `document.querySelectorAll` 能穿透 shadow root，而是沿结构逐层下钻；
- 只对评论结构节点挂 `MutationObserver`，不为每个头像/按钮挂观察器；
- 监听文档、`bili-comments` 的 shadow root、楼中楼容器的 shadow root；
- 命中根评论时隐藏整个 `bili-comment-thread-renderer`，避免留下没有父评论的孤儿子回复；
- 命中楼中楼时只隐藏对应的 `bili-comment-reply-renderer`；
- 旧版页面命中根评论时优先只隐藏 `.root-reply-container`，保留楼中楼；找不到时隐藏整个 `.reply-item`；
- 移动端 `.comment-item` / `[data-comment-id]` 作为兜底。

稳定属性优先：

- 新版：`#user-avatar[data-user-profile-id]`、`#user-name[data-user-profile-id]`、`bili-comments[data-params]`；
- 旧版：`data-mid`、`data-id`、`data-rpid`；
- 链接兜底：`space.bilibili.com/<uid>`；
- class 只用于定位容器，不用于判断用户身份。

评论 rpid 不在可见属性中。脚本在用户点击上报时，才尝试通过页面世界数据桥读取 `__data.rpid`；读不到就退化为页面链接。整个过程不发网络请求。

## 性能

- MutationObserver 回调只做轻量过滤，真正的扫描进入 120ms 防抖队列；
- 单次扫描限制深度，跳过 script/style/图片/图标等无关节点；
- 已处理节点用 `WeakSet` 标记，避免重复解析；
- 高频/模板/去重表都有窗口与容量上限；
- 日志最多 200 条，节点引用随日志裁剪；
- shadow observer 最多 400 个，超出后停止新增，已有评论仍会扫描；
- 只有评论相关页面才启动观察器；非评论页只保留菜单入口。

## 隐私

- **不调用 B 站 API**。脚本里没有任何 `api.bilibili.com` 请求。
- **不自动举报、不拉黑、不做账号操作**。
- **不自动上传评论**。只有用户点击“上报可疑鱼”并自行在 GitHub 提交时，评论内容才离开浏览器。
- 黑名单请求只访问配置的 GitHub Raw / 自定义 HTTPS 地址，不携带 Cookie，`anonymous` / `credentials: omit`。
- 不收集统计、不埋点、不生成设备指纹。
- 日志、白名单、设置、黑名单缓存只存在本机 GM 存储；日志包含评论原文，清空日志即可删除。
- 调试日志只写本地控制台。

## 误判处理

1. 打开面板 -> `日志`；
2. 找到被误伤的评论；
3. 点“恢复”：解除这一条的隐藏，并把这个单条指纹加入白名单；
4. 如果是整个 UID 被误判，点“加入白名单”：该 UID 之后的所有评论都放行，并恢复当前已隐藏的记录；
5. 如果规则太激进，提高阈值、删掉对应关键词，或关闭规则扫描。

白名单保存在 `pf:v1:state`，优先级高于远端黑名单，也不会被远端更新覆盖。

## 已知限制

- 只隐藏当前页面已经渲染出来的评论；不会翻页、不会请求更多评论。
- 高频规则只能看到当前页面加载过的评论，不能跨视频统计。
- 头像指纹是 URL 指纹，不是图像相似度。
- 新版评论的 rpid 依赖页面组件内部数据，B 站改版后可能拿不到。
- B 站移动网页版可能不渲染评论，脚本无法处理不存在的 DOM。
- 远端黑名单是社区维护的，可能有误伤或滞后；最终以本地白名单为准。
- 直接推送 `main` 的 workflow 在开启分支保护时会失败，需要调整策略。

## 开发与测试

项目没有运行时依赖。

```sh
npm test          # 黑名单校验 + Issue 解析单元测试
npm run validate  # 校验 blacklist.json
npm run check     # 语法检查 + 校验 + 测试
```

主要文件：

```text
pkillFish.user.js                        油猴脚本（DOM / 黑名单 / 规则 / 上报 / UI）
blacklist.json                           初始 UID 黑名单模板
keywords.json                            独立昵称/评论关键词模板
scripts/lib/blacklist.mjs                黑名单模型、校验、增量合并
scripts/lib/report-parser.mjs            Issue 正文解析与链接校验
scripts/validate-blacklist.mjs           本地 / CI 校验入口
scripts/validate-keywords.mjs            关键词 JSON 校验入口
scripts/lib/keywords.mjs                 关键词模型、校验与匹配
scripts/apply-report.mjs                 resolved Issue 自动处理
.github/workflows/auto-blacklist.yml     标签驱动的自动化流水线
.github/workflows/validate-blacklist.yml PR / push 校验
.github/ISSUE_TEMPLATE/report-fish.md    上报模板
docs/blacklist-changelog.md              自动变更日志
```

提交前请至少运行：

```sh
npm run check
node scripts/validate-blacklist.mjs blacklist.json
```

## 首次部署检查

- [ ] 确认仓库地址是 `OrO-c/pkillFish`（迁移到其他账号时再改）；
- [ ] 把项目推送到 GitHub 的 `main` 分支；
- [ ] 开启 Actions 的 Read and write 权限；
- [ ] 创建 `report` / `resolved` / `wontfix` 标签；
- [ ] 确认 `blacklist.json` 已提交到 `main`；
- [ ] 用桌面 Chrome / Edge / Firefox 和移动端浏览器各验证一次；
- [ ] 在真实评论区验证：黑名单命中、规则命中、楼中楼、滚动加载、恢复、白名单、上报跳转。

## FAQ

**它会自动举报吗？**

不会。上报按钮只打开 GitHub Issue 新建页，提交动作由用户自己完成。

**它会调用 B 站 API 吗？**

不会。脚本只在本地读取 DOM；唯一的网络请求是拉取你配置的黑名单。

**为什么某条评论没有被隐藏？**

可能不在黑名单、规则分数不够、评论是刚加载还没被扫描、或者 B 站改版导致选择器失效。可以先用“上报可疑鱼”提交 UID，或在日志/控制台观察。

**为什么正常用户被隐藏了？**

社区名单或规则误判。打开日志点“加入白名单”，并考虑提高阈值。误判也可以提 Issue 说明，维护者可以把 UID 放进 `revoked`。

**为什么上报链接里没有 `#reply<rpid>`？**

B 站没有把 rpid 放在可见属性里，页面世界数据桥也拿不到时会退化。Issue 正文仍包含 UID、页面链接和原文，可手动补评论链接。

**为什么没有动画 / 提示音 / 小鱼图标？**

这是刻意设计。pkillFish 的目标是日常静默使用，不是表演。

**支持直播弹幕吗？**

不支持。直播弹幕是另一套 DOM 与协议，不在本项目范围内。

**黑名单更新失败怎么办？**

看面板里的错误文本。常见原因是网络无法访问 GitHub Raw、自定义地址不是 HTTPS、被浏览器 CSP/扩展拦截。离线模式会继续使用本地缓存。

## 免责声明

- 本项目与哔哩哔哩、DeepSeek Harness、DSH 大肥鱼及相关插件作者没有隶属关系。
- 黑名单是社区维护的启发式数据，不构成对任何账号的事实认定。
- 请只提交公开评论区信息，不要用它骚扰、攻击或批量操作任何账号。
- 使用本工具造成的任何后果由使用者自行承担。发现误判请通过日志白名单或 Issue 反馈。

## License

MIT

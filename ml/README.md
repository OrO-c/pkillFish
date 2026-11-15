# pkillFish 轻量文本模型

这是 pkillFish 的实验性本地文本分类工具链：

- `scrape_aicu.py`：通过 Firefox 访问 aicu.cc 的公开查询接口，采集指定 UID 的历史评论。
- `train_model.py`：训练字符 n-gram + 逻辑回归模型，导出浏览器可加载的 `model.json`。
- `artifacts/`：训练产物；其中 `model.json` / `model.card.md` 随主仓库发布，其他中间文件可忽略。
- `data/`：本地样本；不会提交到本仓库。

模型只保存权重和特征配置，不包含原始评论。

## 依赖

只使用公开、常规的依赖：

```text
playwright
scikit-learn
numpy
scipy
```

不使用任何来源不明的 aicu 第三方包。

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install firefox
```

## 采集样本

```bash
python ml/scrape_aicu.py \
  --blacklist blacklist.json \
  --out ml/data \
  --headful
```

默认行为：

- 只处理 `blacklist.json` 中的 UID，跳过 `revoked`；
- **这些账号在 2026-10-01（Asia/Shanghai）之后发布的评论，不论内容，全部作为正样本**；
- 输出到 `ml/data/positives.jsonl`，每行 `label: 1`；
- 评论分页抓取，默认一直抓到接口结束或早于 2026-10 的页；
- `--max-pages 0` 是默认值，表示不设页数上限；
- 原始接口响应保存在 `ml/data/raw/`，便于排查。

### aicu 接口

采集脚本使用的是 aicu.cc 页面自身的公开查询流程，不是 B 站 API：

```text
GET https://api.aicu.cc/api/v4/queue/enqueue
GET https://api.aicu.cc/api/v4/search/getreply
    ?uid=<uid>&pn=<page>&ps=100&keyword=&mode=0
    &need_count=true|false&ticket=<ticket>
```

`ticket` 是一次性的，每次分页都需要重新 `enqueue`。请求通过 Playwright 的 Firefox 页面上下文发出，因此不依赖 curl 的 TLS/反爬行为。

如果页面出现人机验证，使用 `--headful` 手动完成；脚本只读取公开评论，不登录、不提交账号操作。请遵守 aicu.cc 的使用条款，并保持 `--delay` 的低频请求，不要批量高频抓取。

### 负样本

训练需要负样本。可以在 `ml/data/negatives.jsonl` 中提供人工标记的负样本，或者显式使用：

```bash
python ml/scrape_aicu.py \
  --blacklist blacklist.json \
  --out ml/data \
  --include-before-as-negatives \
  --negative-pages 2
```

该选项会把 2026-10 边界之后额外 2 页（默认）的旧评论写入 `negatives.jsonl`，标记 `label: 0`，作为同一账号人类时期的 hard negative。它不是默认行为，因为默认采集范围严格限定为 2026-10 之后；`--negative-pages 0` 表示不额外采集旧页。

训练默认**不加载** `negatives.jsonl`，因为旧评论也可能已经带有 Agent 风格，容易污染负样本。确实要加入时显式加 `--include-pre-cutoff-negatives`。

也可以把其他来源的公开人类评论整理成：

```json
{"uid":"123456","rpid":"111","text":"...","ctime":"2026-10-10T12:00:00+08:00","label":0}
```

训练只读取 `text`、`uid`、`label` 和 `ctime`；不会把 UID 当作特征。正样本判定只看“账号 + 发布时间”，不按评论内容筛选。

### 正常人类评论采集

只靠黑名单账号的历史评论做负样本，UID 数量会偏少，模型容易记住作者风格。可以额外采集公开的正常评论：

```bash
python ml/scrape_human.py \
  --videos 0 \
  --aicu-hot \
  --hot-users 10 \
  --hot-pages 1 \
  --out ml/data/human.jsonl
```

- `--videos N`：从正样本中出现过的 B 站视频页采集公开 DOM 评论，`0` 表示不采集视频页；
- `--aicu-hot`：使用 aicu 热搜 UID 的公开评论作为正常样本；
- 不会调用 `api.bilibili.com`，只读取浏览器页面或 aicu 的公开接口；
- 输出 `human.jsonl`，全部标记 `label: 0`；
- 已经存在于 `blacklist.json` / `revoked` 的 UID 会被排除。

## 训练

```bash
python ml/train_model.py \
  --data ml/data \
  --out ml/artifacts/model.json \
  --target-precision 0.95 \
  --min-samples 200
```

需要同时有正负样本。建议至少准备：

- 数百到数千条正样本；
- 至少同等数量的负样本；
- 至少几十个不同 UID，才能按 UID 分组切分。

脚本会：

- 按规范化文本去重；
- 按 UID 分组切分训练/验证/测试，避免同一作者泄漏；
- 训练 L2 逻辑回归；
- 在验证集上选择满足目标 precision 的阈值；
- 导出 int8 量化权重和模型卡。

输出：

```text
ml/artifacts/model.json
ml/artifacts/model.card.md
```

### 模型格式

```json
{
  "format": "pkillfish-ml-v1",
  "version": "0.1.0",
  "features": {
    "buckets": 65536,
    "ngramMin": 1,
    "ngramMax": 4,
    "hash": "fnv1a32"
  },
  "bias": -1.2,
  "quantScale": 0.012,
  "weights": "base64-int8",
  "threshold": 0.95
}
```

浏览器端用纯 JS 重做同样的 NFKC、URL/提及规范化、字符 n-gram 和 FNV-1a 哈希，再对 int8 权重做点积。模型文件通常只有几十到几百 KB。

## 发布模型

模型默认随主仓库发布，路径固定为：

```text
ml/artifacts/model.json
ml/artifacts/model.card.md
```

默认加载地址：

```text
https://raw.githubusercontent.com/OrO-c/pkillFish/main/ml/artifacts/model.json
```

训练完成后，把新的 `model.json` 和 `model.card.md` 提交到主仓库即可。原始训练数据仍在 `.gitignore` 中，不会提交。

也可以把模型放到独立仓库、jsDelivr 或自己的静态服务器，然后在 pkillFish 设置页的“模型地址”中填写完整 HTTPS URL。

## 误判负样本

被实验模型判定为 AI 的评论旁会出现“报告误判”按钮，打开标题以 `[ml-false-positive]` 开头的 Issue。它只用于收集负样本，不会进入 UID 黑名单，也不依赖仓库预建标签。

审核规则：

- 关闭为 `completed`，或加 `ml-false-positive-accepted` 标签：通过，作为加权负样本；
- 关闭为 `not planned`，或加 `wontfix`：不通过，不收集。

收集：

```bash
python ml/collect_false_positives.py --repo OrO-c/pkillFish
```

脚本只读取公开 Issue，输出 `ml/data/false-positives.jsonl`。通过的样本带：

```json
{"label": 0, "weight": 3}
```

训练时 `train_model.py` 会把这些权重传给逻辑回归；普通负样本权重为 1。默认 `--data ml/data` 会自动加载这个文件。

标签不是必需的；如果需要 GitHub 侧筛选，可以创建：

```text
ml-false-positive
ml-false-positive-accepted
```

不创建标签也能通过标题和隐藏 meta 收集。

## 在脚本中使用
## 在脚本中使用

1. 打开 pkillFish 设置页；
2. 启用“实验性模型”；
3. 点击“加载本页模型”；
4. 模型只在当前页面手动加载，切换页面后释放；
5. 默认“仅在名称旁标记，不隐藏”；
6. 关闭该开关后，命中的评论会折叠进“已屏蔽肥鱼”，但红色标识仍保留。

模型加载后只影响当前页面，不会自动下载，也不会写进用户状态。

## 注意事项

- 训练数据只应包含公开评论，不要提交私信、Cookie、账号凭据或个人信息。
- 关键词规则和 UID 黑名单仍然是主规则；模型是实验性补充。
- 红底标识使用高 precision 阈值；误判时通过日志恢复或加入白名单。
- 不要用单一视频或单一作者的模板训练，否则模型会记住模板而不是说话方式。
- aicu 接口可能变化；采集失败时优先用 `--headful` 检查页面是否触发验证，或调整接口适配。

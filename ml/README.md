# pkillFish 轻量文本模型

这是 pkillFish 的实验性本地文本分类工具链：

- `scrape_aicu.py`：通过 Firefox 访问 aicu.cc 的公开查询接口，采集指定 UID 的历史评论。
- `train_model.py`：训练字符 n-gram + 逻辑回归模型，导出浏览器可加载的 `model.json`。
- `artifacts/`：本地训练产物；不会提交到本仓库。
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
  --max-pages 10
```

该选项会把 2026-10 之前的评论写入 `negatives.jsonl`，标记 `label: 0`，作为同一账号人类时期的 hard negative。它不是默认行为，因为默认采集范围严格限定为 2026-10 之后。

也可以把其他来源的公开人类评论整理成：

```json
{"uid":"123456","rpid":"111","text":"...","ctime":"2026-10-10T12:00:00+08:00","label":0}
```

训练只读取 `text`、`uid`、`label` 和 `ctime`；不会把 UID 当作特征。正样本判定只看“账号 + 发布时间”，不按评论内容筛选。

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

训练产物可以放在独立仓库，例如：

```text
https://github.com/OrO-c/pkillFish-models
```

把 `model.json` 和 `model.card.md` 放到该仓库根目录：

```text
pkillFish-models/
├── model.json
└── model.card.md
```

默认加载地址是：

```text
https://raw.githubusercontent.com/OrO-c/pkillFish-models/main/model.json
```

如果使用其他仓库、jsDelivr 或自己的静态服务器，在 pkillFish 设置页的“模型地址”中填写完整 HTTPS URL。

创建独立仓库的示例：

```bash
mkdir pkillFish-models && cd pkillFish-models
git init
git remote add origin git@github.com:<your-name>/pkillFish-models.git
cp ../pkillFish/ml/artifacts/model.json .
cp ../pkillFish/ml/artifacts/model.card.md .
git add model.json model.card.md
git commit -m "model: initial release"
git push -u origin main
```

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

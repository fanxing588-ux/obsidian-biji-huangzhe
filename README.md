# 笔记拾荒者 (biji-huangzhe)

Obsidian 插件:写作时,自动从你的 vault 旧笔记里召回**相关 / 反向 / 案例 / 金句**片段,以拾荒卡片浮现在右侧面板。

不是搜索,不是知识库,不是 AI 总结——是**创作时的外置联想**。

## 工作原理

1. 你在任何 .md 笔记里写作
2. 停顿 2 秒,系统取光标前最后两段作为 query
3. 调用 embedding API 算 query 向量
4. 和 vault 里所有笔记的 chunk embedding 算余弦相似度
5. 取 top 1-2 最相关,在右侧面板浮现卡片

## 安装

### 推荐:通过 BRAT(自动更新,装一次终身)

BRAT(Beta Reviewer Auto-update Tool)是 Obsidian 生态里专门用来管理"还没上架官方市场的插件"的工具。装一次,之后每次我发新版,你**点一下就能更新**,不用再手动覆盖文件。

**三步装上**:

1. 在 Obsidian 里:**设置 → 第三方插件 → 浏览**,搜 `BRAT`,装上并启用
2. 打开 BRAT 设置 → **Add Beta plugin** → 填仓库 URL:
   ```
   fanxing588-ux/obsidian-biji-huangzhe
   ```
3. BRAT 会自动从最新 Release 拉取 `main.js / manifest.json / styles.css`,装到 `.obsidian/plugins/biji-huangzhe/`。然后在**设置 → 第三方插件**里启用「笔记拾荒者」即可

**更新**:之后我每次发新版,BRAT 会自动检测(或你在 BRAT 设置里点 "Check for updates" 立即检查),提示你一键更新。不需要再手动下载/覆盖文件。

**遇到问题**:BRAT 提示找不到 Release → 看本 repo 的 Releases 标签页,确认有最新版本;BRAT 拉取失败 → 国内网络不通 GitHub raw 资源,可以临时手动安装(下面)。

### 手动安装(网络不通 GitHub / 不想装 BRAT)

去本仓库 **Releases** 页,下载最新 Release 里的三个文件:`main.js` / `manifest.json` / `styles.css`,放到:

```
你的vault/
  .obsidian/
    plugins/
      biji-huangzhe/        ← 新建这个目录
        main.js
        manifest.json
        styles.css
```

然后在 Obsidian 里:**设置 → 第三方插件 → 关闭安全模式 → 启用「笔记拾荒者」**。

⚠ 缺点:之后每次更新都得重新下载三个文件覆盖。强烈建议优先用 BRAT。

### 开发者:本地开发模式

如果你想改代码 / 帮我修 bug,需要 Node.js 18+ 和 npm:

```bash
git clone <这个 repo>
cd obsidian-biji-huangzhe
npm install
npm run build      # 一次性构建,产出 main.js
# 或
npm run dev        # watch 模式,改完自动重编译
```

把整个目录软链到你 vault 的 `.obsidian/plugins/biji-huangzhe/`:

```powershell
# Windows PowerShell
New-Item -ItemType Junction -Path "你的vault\.obsidian\plugins\biji-huangzhe" -Target "C:\path\to\obsidian-biji-huangzhe"
```

```bash
# macOS / Linux
ln -s /path/to/obsidian-biji-huangzhe ~/Documents/你的vault/.obsidian/plugins/biji-huangzhe
```

Obsidian 里改完代码按 `Ctrl+R` 重载即可。

## 配置

启用后,**设置 → 笔记拾荒者**,填:

| 字段 | 默认值 | 说明 |
|---|---|---|
| API Endpoint | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 阿里云百炼(dashscope)。也支持任何 OpenAI 兼容的 endpoint |
| Model | `text-embedding-v4` | dashscope 当前最强中文 embedding |
| Dimensions | `2048` | v4 最高维度,质量比默认 1024 强一档 |
| API Key | (填你自己的) | 在阿里云百炼控制台创建 |

填完后,**滚到底部,点「开始索引」**,会遍历 vault 里所有 .md 笔记,切块,批量算 embedding。100 篇笔记大约几分钟。

索引完成后,任意打开一个笔记开始写,**右侧自动浮现卡片**(如果右侧面板没打开,Ctrl+P 搜「打开拾荒面板」)。

## 命令

通过 Ctrl+P 命令面板调用。所有命令都以 "笔记拾荒者:" 开头(Obsidian 默认行为)。

| 命令 | 说明 |
|---|---|
| 打开拾荒面板 | 在右侧打开/聚焦 |
| 索引整个 vault | 重新计算所有 embedding |
| 手动拾一下 | 当前段落立即触发匹配(不等停顿) |
| 切换专注模式 | 暂停/恢复召回(纯写作时用) |
| 切换反打扰 | 冷却 / 7天去重 / 拉黑 全部开关(调阈值时关) |
| 切换自动召回 | 写作停顿 2s 自动拾 vs 只走显式触发 |
| 重新索引当前笔记 | 当前文件被改坏 / 索引漂移时单独重算 |
| 复制最后召回的卡片 | 把刚才面板里的卡片以纯文本格式复制走 |
| 查看索引状态 | Notice 弹出:vault 文件数 / 已索引 / chunk / embedding / 错误数 |
| 清空所有索引 | 二次确认,清空 chunksByPath + embeddings.bin |

底栏会显示一个 🪶 小图标(Obsidian 右下角 status bar),实时反馈状态:
- `🪶 X 篇 · N` —— 就绪,已索引 X 篇笔记,N 个 embedding chunk
- `🪶 未配置` —— 黄字,API key 没填
- `🪶 索引 3/120` —— 蓝字,正在索引
- `🪶 失败 ×N` —— 红字,最近有 N 次索引/召回失败(打开控制台 Ctrl+Shift+I 看详情)

点击底栏图标会弹出"查看索引状态"详细面板。

## 卡片交互

- **看原文 →**:跳到原笔记,光标定位到那一段
- **有用 / 没用**:反馈(暂时只是 Notice 提示,不影响后续排序)
- **别再提醒**:把这一条加入隐藏列表

卡片 hover 时才显示三个按钮——默认极简。

## 配色

类型用左侧 2px 色条 + 极小圆点:
- 蓝 = 相似
- 橙红 = 反向
- 绿 = 案例
- 琥珀 = 金句

## 数据存储

所有数据存在 `vault/.obsidian/plugins/biji-huangzhe/data.json`:
- 你的 settings(**包括 API key 明文**)
- 每篇笔记的切块结构
- 每个 chunk 的 embedding 向量(占大头)
- 反打扰状态:`hidden`(别再提醒)、`shown`(N 天去重)、`feedback`(有用/没用计数)

**embedding cache 单次预计算,以后只增量更新**(笔记修改时自动重算变化的 chunk)。

⚠️ 这个文件含敏感信息,看下一节"隐私 / API key 安全"。

## 隐私 / API key 安全

`data.json` 里两类数据可能让你不舒服:**明文 API key** + **所有笔记的 embedding 向量**(向量可以反向暴露笔记主题)。

### 风险

- vault 同步到 iCloud / OneDrive / Dropbox / git → 这个文件会跟着同步
- 整个 vault 分享给别人 → key 直接泄
- 提 issue 时贴 data.json 内容 → key 泄

### 方案 A:同步时排除 data.json(简单)

用 git 同步 vault 时,在 `.gitignore` 里加:
```
.obsidian/plugins/biji-huangzhe/data.json
```

Obsidian Sync / iCloud 也支持排除特定文件,具体看各自文档。

注意:排除后,**embedding 缓存也不会跨设备同步**,每台机器都要重新索引一次。

### 方案 B:用环境变量代替 settings 里的 key(推荐)

设环境变量 `BIJI_API_KEY`,把 Settings 里的 API Key **留空**。插件会优先用环境变量,key 就不会写入 data.json。

Settings 顶部会实时显示当前是否检测到环境变量(绿色 ✓ = 检测到)。

**Windows PowerShell**(永久,需重启 Obsidian):
```powershell
[Environment]::SetEnvironmentVariable("BIJI_API_KEY", "sk-...", "User")
```

**macOS / Linux**,在 `~/.zshrc` 或 `~/.bashrc` 加:
```bash
export BIJI_API_KEY="sk-..."
```
然后从 terminal 启动 Obsidian(GUI 启动可能读不到 shell 环境变量,需要单独设全局 env)。

### 方案 C:完全离线 — Ollama 本地 embedding

如果你不想把笔记内容传到任何云端 API,可以用 Ollama 跑本地 embedding:

1. 装 Ollama:https://ollama.com
2. 拉一个中文 embedding 模型:
   ```bash
   ollama pull bge-m3
   ```
3. Settings → 笔记拾荒者 :
   - API Endpoint: `http://localhost:11434/v1`
   - Model: `bge-m3`
   - Dimensions: `1024`(bge-m3 默认维度)
   - API Key: 任意非空字符串(Ollama 不校验,但插件 isReady 要求 key 非空)
4. **重新索引** —— 模型换了维度就变,旧 embedding 缓存全部失效

LLM 二段式也可以走 Ollama:Chat Model 填 `qwen2.5:7b` 或 `glm4:9b` 之类的本地模型(先 `ollama pull` 拉下来)。整套链路完全离线,只是质量会比云端低一档。

## LLM 二段式:用 Claude 还是 qwen

**embedding 必须用 dashscope / OpenAI / Ollama**(Anthropic 没有 embedding API)。

**LLM 二段式判定**(reason 那一步)可以选 provider:

| Provider | 适合 | 价格(粗略) |
|---|---|---|
| OpenAI 兼容 / qwen-turbo | 默认。够用,中文还行,便宜 | ¥0.001 / 次 judge |
| OpenAI 兼容 / qwen-plus | qwen 里质量最好的 | ¥0.005 / 次 |
| Anthropic / claude-haiku-4-5 | 中文判断更精准,反向类型识别更稳 | ¥0.02 / 次 |
| Anthropic / claude-sonnet-4-6 | 顶配,但对这个场景过剩 | ¥0.10 / 次 |

切到 Claude 的步骤:

1. Settings → 笔记拾荒者 → LLM 二段式判定 → **Provider** 选 `Anthropic (Claude)`
2. Settings 会自动重载,字段切到 Anthropic 模式
3. **Chat API Key** 填你的 `sk-ant-...`,或者更安全的做法是用环境变量(见下)
4. **Chat Model** 默认填 `claude-haiku-4-5-20251001`,你也可以改成 `claude-sonnet-4-6`
5. **Chat Endpoint** 一般留空(默认 https://api.anthropic.com),除非你走代理

### Anthropic key 用环境变量

和 embedding 一样,推荐用环境变量代替明文存盘。**Anthropic 用单独的 env**:`BIJI_ANTHROPIC_API_KEY`。

Windows PowerShell:
```powershell
[Environment]::SetEnvironmentVariable("BIJI_ANTHROPIC_API_KEY", "sk-ant-...", "User")
```

macOS / Linux:
```bash
export BIJI_ANTHROPIC_API_KEY="sk-ant-..."
```

重启 Obsidian 后,Settings 里 Chat API Key 字段下方会显示绿色 ✓。

### 注意:Chat 和 Embedding 是分开的两套配置

页面顶部的 **API Endpoint / API Key** 是给 **embedding** 用的(召回那一步,必须 OpenAI 兼容)。
LLM 二段式判定区下面的 **Chat Endpoint / Chat API Key** 是给 **LLM judge** 用的(可独立切到 Anthropic)。

如果你 chat 和 embedding 都用同一家(比如全 dashscope),Chat Endpoint / Chat API Key 留空即可,会自动 fallback 到上面那套。

### 用第三方 Claude 中转服务(代理)

如果你买了某个 Claude 中转服务(咸鱼上常见的 simpleai / DeepSider / one-api 等聚合服务),通常它们用 **Anthropic 协议兼容**,只是 endpoint 不是 anthropic.com。配法:

1. Provider 选 `Anthropic (Claude)`
2. **Chat Endpoint** 填中转服务给的 base URL,比如 `https://key.simpleai.com.cn`(带不带 `/v1` 都行,插件会自动处理)
3. **Chat API Key** 填中转服务给的 `sk-xxx`(注意:这跟 Anthropic 官方的 `sk-ant-...` 格式不同,这是中转服务自己签的)
4. **Chat Model** 填中转服务支持的 Claude 模型 ID,比如 `claude-haiku-4-5-20251001` 或 `claude-sonnet-4-6`(具体看你的服务支持哪些)

中转服务通常比官方便宜,但有几个坑:
- **稳定性差一档**:某些时段会限流或失败,我们的 LLM 二段式有 fallback 到启发式,不会全断
- **模型 ID 受限**:只支持服务白名单内的,填错会报错(中转一般不会回退,直接 4xx)
- **Key 泄漏风险**:跟 Anthropic 一样,推荐用环境变量 `BIJI_ANTHROPIC_API_KEY` 代替明文存盘

## 调阈值

在设置里:

- **最低相关度**(默认 0.45):低于此分不召回。觉得卡片噪声多 → 调到 0.5+
- **反向类型门槛**(默认 0.7):sim 高于此分才能标"反向",否则降级"相似"。觉得反向标错多 → 调到 0.75+

## 已知边界

- **中文 embedding 是主题级,不是论点级**:无法区分"亲密关系痛苦"和"价值观痛苦"——都命中"痛苦"主题。要做到真"反向论点"匹配,需要 LLM 在 embedding 之上加一层判断
- **第一次索引大 vault 慢**:1000 篇笔记可能 10-20 分钟,会消耗一些 API 额度
- **dashscope 免费额度**:新用户 100 万 token,够用很久。用完后充值 10 元能用半年级别

## 项目结构

```
obsidian-biji-huangzhe/
  manifest.json         # 插件元数据
  package.json          # npm 依赖
  tsconfig.json         # TS 配置
  esbuild.config.mjs    # 构建脚本
  main.ts               # 所有逻辑(单文件,~700 行)
  styles.css            # 卡片样式
  README.md             # 你正在看的
```

## 开发参考

- 本插件源自一个浏览器 Demo(`诈尸笔记/index.html`),验证完体验后移植到 Obsidian
- 核心算法:**embedding cosine 相似度** + 句式启发式分类(反向/案例/金句)
- 所有逻辑在 `main.ts` 单文件里,方便阅读和修改

## Changelog

### 0.3.0 (2026-05)

**Relevance Feedback / 锚点搜索 —— 颠覆性的迭代检索**

不是向量平均(那个跳不出邻近聚类),而是让 LLM 当"查询演化器":你钉★ 觉得对的卡片当锚点 → LLM 看 query + 锚点 + 上一轮未钉的卡片(负反馈) → **重写一个全新的 query 文本** → 用新 query 召回。每次 refine,query 文本都在演化,搜索方向跟你的标记一起长出来。

- 卡片头部 ★ 钉选按钮(hover 浮现,pinned 时琥珀色)
- refine bar:`AI · 理解` / `AI · 改写` / boost·exclude 概念词标签
- 防过拟合:最多用最近 6 个锚点;LLM 显式检查锚点冲突,矛盾时给警告
- 混合向量召回:`0.6 × LLM 新 query 向量 + 0.4 × 锚点 mean 向量`,锚点做稳定锚防 LLM 飘
- refine 期间旧卡片模糊淡出 + 中央浮"AI · 召回中"指示器,避免信息错配
- 新命令:"以钉选的锚点再找一次"

**配置要求:** chat API 必须配好(设置 → LLM 二段式判定 → 填 chat 模型 + key)

### 0.2.0 (2026-05)

**稳定性**

- `vault.modify` 加 per-file debounce(3s):连续打字/频繁保存时,同一文件合并成一次 indexFile,避免狂烧 embedding API
- 3 处 silent catch 改为 `console.error` + status bar 错误计数
- `EmbedClient` 5xx / 429 / 网络抖动自动重试一次(800ms 退避)
- `Matcher.match` 不再内部弹 Notice;autoTrigger 失败安静,只走状态条;主动搜索失败才弹

**新增 UX**

- 底栏 status bar:实时反馈"已索引 X 篇 · N embedding"/"未配置"/"索引中 3/120"/"失败 ×N"
- 空状态分情况引导:API 未配 → 提示去设置;索引为空 → 提示跑「索引整个 vault」
- 卡片底部加"3 个月前"风格的时间小字,基于 `TFile.stat.mtime`(拾荒感的灵魂)

**新增 6 个命令**

- 切换反打扰 / 切换自动召回 / 重新索引当前笔记 / 复制最后召回的卡片 / 查看索引状态 / 清空所有索引

### 0.1.0 (2026-05)

首发版本。embedding + LLM 二段式判定 + RRF hybrid 搜索 + dashscope rerank。

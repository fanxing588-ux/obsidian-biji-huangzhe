import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  debounce,
} from "obsidian";

// ============================================================================
// 类型 / 默认配置
// ============================================================================

interface BijiSettings {
  endpoint: string;
  model: string;
  dimensions: number;
  apiKey: string;
  triggerDelayMs: number;
  minQueryChars: number;
  minSim: number;
  minSimTop2: number;
  topK: number;
  reverseMinSim: number;
  chunkMin: number;
  chunkMax: number;
  // LLM 二段式判定:embedding 召回后让 LLM 判类型 + 给 reason
  useLlmJudge: boolean;
  chatProvider: "openai-compat" | "anthropic"; // 默认 openai-compat (dashscope/qwen);anthropic = Claude
  chatEndpoint: string;                          // 留空 = 用上面的 endpoint(向后兼容)
  chatApiKey: string;                            // 留空 = 用上面的 apiKey
  chatModel: string;
  llmTopK: number;
  // 反打扰
  cooldownMs: number;
  dedupDays: number;
  focusMode: boolean;
  antiNoise: boolean; // true = 启用冷却 / 7 天去重 / useless 黑名单;默认 false 不限制(用户自己想开再开)
  autoTrigger: boolean; // 写作时自动召回卡片;默认 false(只走显式触发:搜索框/右键/命令)
  // 搜索 reranker(dashscope gte-rerank-v2 等)—— hybrid 召回 top-N 后用 rerank 模型重排
  useRerank: boolean;
  rerankModel: string;
  // 个性化:用"有用/没用"反馈算出偏好向量(Rocchio centroid),给主题相似的候选加分。
  // 0 = 关闭(纯检索) / 1 = 适中(推荐) / 2 = 激进(强烈跟着你的标记走)
  personalizationStrength: 0 | 1 | 2;
}

const DEFAULT_SETTINGS: BijiSettings = {
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "text-embedding-v4",
  dimensions: 2048,
  apiKey: "",
  triggerDelayMs: 2000,
  minQueryChars: 20,
  minSim: 0.45,
  minSimTop2: 0.6,
  topK: 5,
  reverseMinSim: 0.7,
  chunkMin: 60,   // 细切块默认值:让短句独立成 chunk,rerank 能精确锁定具体观点
  chunkMax: 200,  // 之前是 [120, 500] 太大,多个论点被聚合到一个 chunk 互相稀释
  useLlmJudge: true,
  chatProvider: "openai-compat",
  chatEndpoint: "",
  chatApiKey: "",
  chatModel: "qwen-plus",
  llmTopK: 5,
  cooldownMs: 60000,
  dedupDays: 7,
  focusMode: false,
  antiNoise: false, // 默认关闭反打扰 —— 新装即用,纯 embedding+LLM 决定召回
  autoTrigger: false, // 默认关闭自动召回 —— 只走显式触发(搜索框/右键/命令),不占用户注意力
  useRerank: true, // 搜索时用 rerank 模型重排,精度跳一档(每次约 ¥0.005)
  rerankModel: "gte-rerank-v2",
  personalizationStrength: 1, // 默认适中:有用/没用反馈生成偏好向量,给相似主题加分(冷启动时无效)
};

const VIEW_TYPE_BIJI = "biji-huangzhe-view";

interface Chunk {
  id: string;
  notePath: string;
  noteTitle: string;
  index: number;
  text: string;
  start: number;
  end: number;
}

type MatchType = "similar" | "opposite" | "case" | "quote";

interface MatchResult {
  chunkId: string;
  text: string;
  notePath: string;
  noteTitle: string;
  type: MatchType;
  sim: number;
  shared: string[];
  why: string;
  snippet: string; // 卡片显示的那句话(未截断),也是看原文的定位锚点
}

const TYPE_LABEL: Record<MatchType, string> = {
  similar: "相似",
  opposite: "反向",
  case: "案例",
  quote: "金句",
};

// ============================================================================
// 工具:Tokenize / Embedding helpers / 切块 / 类型判定 / Snippet 提取
// ============================================================================

const STOPWORDS = new Set(
  (
    "的了是在和与或而但也都就还才又再吧吗呢啊呀这那一个我你他她它我们你们他们这个那个什么怎么如何为何因为所以但是不过" +
    "然后于是这样那样以及之上之下之前之后已经一些有些某些可以应该可能也许大概比较非常更加最为" +
    "嗯啊呃哎呀哈呐嘛哦哇喂诶" +
    "就是然后那个这个那种这种或者其实其他还有比如对吧" +
    "你说我说他说你看我看他看" +
    "得着过地把被向于让给对从把要去会能将"
  ).split("")
);

function extractNgrams(text: string, n = 2): string[] {
  const parts = text.toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  const grams = new Set<string>();
  for (const part of parts) {
    if (/^[a-z0-9_-]+$/.test(part)) {
      if (part.length >= 2 && !/^\d+$/.test(part)) grams.add(part);
      continue;
    }
    for (let i = 0; i + n <= part.length; i++) {
      const g = part.slice(i, i + n);
      if (g.length !== n) continue;
      if (STOPWORDS.has(g[0]) || STOPWORDS.has(g[1])) continue;
      if (/\d/.test(g)) continue;
      grams.add(g);
    }
  }
  return [...grams];
}

function cosine(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

// 多个向量取平均(用于 Rocchio relevance feedback 的锚点向量)
function meanVec(vecs: number[][]): number[] {
  if (!vecs.length) return [];
  const dim = vecs[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vecs) {
    const k = Math.min(dim, v.length);
    for (let i = 0; i < k; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

// 加权混合:wa * a + wb * b。用于把原 query 向量和锚点平均向量调和。
function mixVec(a: number[], b: number[], wa: number, wb: number): number[] {
  const n = Math.min(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = wa * a[i] + wb * b[i];
  return out;
}

const RE_REVERSE = [
  /不是.{1,30}(?:而是|是)/,
  /并不|并非|而非/,
  /其实不/,
  /恰恰相反/,
  /反而/,
  /然而/,
  /真正(?:的|让|让人)/,
  /误以为/,
  /不过.{1,15}才/,
];
// case 启发式只在 LLM 二段式关掉时生效。规则收窄:只匹配真正的"案例引入语"
// 和"具体时间/人物"信号,避免观点笔记里随便出现"项目/用户/公司"就被误标 case。
const RE_CASE = [
  /(?:比如|例如|举个例子|举例|案例|譬如|有一次|有一回|有个|有位|有人|有的是)/,
  /(?:那时候|那一年|后来(?:[他她我]|[他她我]们|那)|曾经|记得有次|记得那次|当时(?:[他她我]|[他她我]们|那))/,
  /(?:我有个(?:朋友|同事|学生|同学|读者)|有个(?:朋友|同事|学生|同学|读者|老板|客户))/,
  /\d{4}年(?:\d{1,2}月)?/,                              // 真实年份(可带月份)
  /\d{1,2}月\d{1,2}[日号]/,                             // 真实日期
];
const RE_QUOTE = [
  /.{1,30}不是.{1,30}(?:而是|是).{1,30}/,
  /真正的.{1,20}(?:是|在于)/,
  /.{1,15}的本质(?:是|在于)/,
  /^[「『""].{4,80}[」』""]/m,
  /(?:可以|应该|不要|必须)(?:把|让|做|看作)/,
];

function detectType(text: string, sim: number, reverseMinSim: number): MatchType {
  const isShort = text.length < 90;
  // 反向 = 候选块有反向句式 + sim 足够高(避免低相关误标反向)
  if (sim >= reverseMinSim && RE_REVERSE.some((re) => re.test(text))) return "opposite";
  if (isShort && RE_QUOTE.some((re) => re.test(text))) return "quote";
  if (RE_CASE.some((re) => re.test(text))) return "case";
  return "similar";
}

function pickReverseSentence(text: string): string | null {
  const patterns = [
    /[^。.!?！？\n]{0,40}不是[^。.!?！？\n]{1,40}(?:而是|是)[^。.!?！？\n]{1,40}[。.!?！？]?/,
    /[^。.!?！？\n]{0,40}(?:并非|而非)[^。.!?！？\n]{1,40}[。.!?！？]?/,
    /[^。.!?！？\n]{0,30}(?:恰恰相反|反而|其实不|真正的)[^。.!?！？\n]{1,40}[。.!?！？]?/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[0].length > 8) return m[0].trim();
  }
  return null;
}

// 选出 chunk 内最相关的"那一句"(未截断)。
// 卡片显示和"看原文"跳转都用这一句,保证两边对齐。
function pickRelevantSentence(text: string, sharedWords: string[]): string {
  const sentences: string[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if (/[。.!?！？\n]/.test(text[i])) {
      const trimmed = buf.trim();
      if (trimmed) sentences.push(trimmed);
      buf = "";
    }
  }
  if (buf.trim()) sentences.push(buf.trim());
  if (!sentences.length) return text;
  if (sentences.length === 1 || !sharedWords?.length) return sentences[0];
  const scored = sentences.map((s, i) => {
    let hits = 0;
    for (const w of sharedWords) if (s.includes(w)) hits++;
    return { s, i, hits };
  });
  scored.sort((a, b) => b.hits - a.hits || a.i - b.i);
  return scored[0].hits > 0 ? scored[0].s : sentences[0];
}

function pickRelevantSnippet(text: string, sharedWords: string[], maxLen = 80): string {
  const s = pickRelevantSentence(text, sharedWords);
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

function buildWhy(type: MatchType, text: string): string {
  if (type === "opposite") {
    const rev = pickReverseSentence(text);
    if (rev) {
      const reved = rev.length < 80 ? rev : rev.slice(0, 75) + "…";
      return `反向判断:"${reved}"`;
    }
    return "这条立场可能反驳你正在写的。";
  }
  switch (type) {
    case "case": return "这条里有相关的具体案例。";
    case "quote": return "这是一句相关判断,适合作标题或收尾。";
    default: return "这条角度可以补充你正在写的内容。";
  }
}

// 切块:按段落聚合到 [min, max],记录原文起止位置(用于跳转)
function chunkNote(content: string, opts: { min: number; max: number }): { text: string; start: number; end: number }[] {
  const paras: { text: string; start: number }[] = [];
  const lines = content.split("\n");
  let buf = "";
  let bufStart = 0;
  let charPos = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (line.trim() === "") {
      if (buf.trim()) { paras.push({ text: buf.trim(), start: bufStart }); buf = ""; }
    } else if (/^#{1,6}\s/.test(line)) {
      if (buf.trim()) paras.push({ text: buf.trim(), start: bufStart });
      paras.push({ text: line.trim(), start: charPos });
      buf = ""; bufStart = charPos + lineLen;
    } else {
      if (!buf) bufStart = charPos;
      buf += line + "\n";
    }
    charPos += lineLen;
  }
  if (buf.trim()) paras.push({ text: buf.trim(), start: bufStart });

  // 长段按句号切
  const units: { text: string; start: number }[] = [];
  for (const p of paras) {
    if (p.text.length <= opts.max) { units.push(p); continue; }
    const sentences = p.text.split(/(?<=[。!?！？;;])\s*/).filter((s) => s.trim());
    let pos = p.start;
    for (const s of sentences) {
      const idx = content.indexOf(s, pos);
      units.push({ text: s, start: idx >= 0 ? idx : pos });
      pos = (idx >= 0 ? idx : pos) + s.length;
    }
  }

  // 聚合到 [min, max]
  const chunks: { text: string; start: number; end: number }[] = [];
  let bufText = "";
  let bufS = 0;
  for (const u of units) {
    if (u.text.length < 30 && !bufText) continue;
    if (!bufText) bufS = u.start;
    if (bufText.length + u.text.length < opts.max) {
      bufText += (bufText ? "\n" : "") + u.text;
    } else {
      if (bufText.length >= opts.min) chunks.push({ text: bufText, start: bufS, end: bufS + bufText.length });
      bufText = u.text;
      bufS = u.start;
    }
  }
  if (bufText.length >= opts.min) {
    chunks.push({ text: bufText, start: bufS, end: bufS + bufText.length });
  } else if (bufText && chunks.length) {
    const last = chunks[chunks.length - 1];
    last.text += "\n" + bufText;
    last.end = bufS + bufText.length;
  }
  return chunks;
}

// ============================================================================
// API Key:优先环境变量(BIJI_API_KEY)避免明文写盘
// ============================================================================

function effectiveApiKey(settings: BijiSettings): string {
  // env 在 Obsidian desktop(Electron)下可用;mobile 没有 process,守护一下
  const env =
    typeof process !== "undefined" && process.env && process.env.BIJI_API_KEY
      ? process.env.BIJI_API_KEY
      : "";
  return env || settings.apiKey || "";
}

function hasEnvApiKey(): boolean {
  return !!(typeof process !== "undefined" && process.env && process.env.BIJI_API_KEY);
}

// Chat (LLM judge) 的 endpoint / key 可独立于 embedding —— 因为 Anthropic 必须用不同 endpoint/key。
// 留空时 fallback 到 embedding 配置,向后兼容。
function effectiveChatEndpoint(settings: BijiSettings): string {
  if (settings.chatEndpoint && settings.chatEndpoint.trim()) return settings.chatEndpoint.trim();
  // anthropic provider 留空时默认官方 endpoint
  if (settings.chatProvider === "anthropic") return "https://api.anthropic.com";
  return settings.endpoint;
}

function effectiveChatApiKey(settings: BijiSettings): string {
  // anthropic 优先 BIJI_ANTHROPIC_API_KEY env;openai-compat 优先 BIJI_API_KEY env(沿用 embedding)
  if (settings.chatProvider === "anthropic") {
    const env =
      typeof process !== "undefined" && process.env && process.env.BIJI_ANTHROPIC_API_KEY
        ? process.env.BIJI_ANTHROPIC_API_KEY
        : "";
    if (env) return env;
    if (settings.chatApiKey && settings.chatApiKey.trim()) return settings.chatApiKey.trim();
    // anthropic 必须有独立 key,不 fallback 到 embedding apiKey(那是别家的 key)
    return "";
  }
  // openai-compat:chatApiKey 优先,否则 fallback 到 embedding 的(effectiveApiKey 已含 env 处理)
  if (settings.chatApiKey && settings.chatApiKey.trim()) return settings.chatApiKey.trim();
  return effectiveApiKey(settings);
}

function hasEnvAnthropicKey(): boolean {
  return !!(typeof process !== "undefined" && process.env && process.env.BIJI_ANTHROPIC_API_KEY);
}

// 智能拼接 chat URL,容忍用户填 endpoint 的不同形态:
//   - "https://x.com"            → 拼 /v1/chat/completions
//   - "https://x.com/v1"         → 拼 /chat/completions
//   - "https://x.com/v1/chat/completions" → 直接用
// 中转服务(如 simpleai)文档里 base URL 有时带 /v1 有时不带,这个 helper 让两种都跑通。
function buildChatUrl(endpoint: string, suffix: "chat/completions" | "messages"): string {
  const base = endpoint.replace(/\/+$/, "");
  if (base.endsWith("/" + suffix)) return base;
  if (/\/v1$/.test(base)) return base + "/" + suffix;
  return base + "/v1/" + suffix;
}

// ============================================================================
// EmbedClient
// ============================================================================

class EmbedClient {
  constructor(private settings: BijiSettings) {}
  isReady(): boolean {
    const s = this.settings;
    return !!(s.endpoint && s.model && effectiveApiKey(s));
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.isReady()) throw new Error("未配置 API");
    // 网络/5xx 偶发抖动重试一次(中间退避 800ms)。4xx 是配置问题,重试也没用,直接抛。
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
      try {
        return await this._embedOnce(texts);
      } catch (e) {
        lastErr = e as Error;
        const msg = lastErr.message || "";
        const retriable =
          /HTTP\s+5\d\d/.test(msg) ||
          /HTTP\s+429/.test(msg) ||
          /fetch|network|ECONN|ETIMEDOUT|timeout|aborted/i.test(msg) ||
          !msg.includes("HTTP");
        if (!retriable) break;
      }
    }
    throw lastErr ?? new Error("embed failed");
  }

  private async _embedOnce(texts: string[]): Promise<number[][]> {
    const url = this.settings.endpoint.replace(/\/+$/, "") + "/embeddings";
    const body: Record<string, unknown> = {
      model: this.settings.model,
      input: texts,
      encoding_format: "float",
    };
    if (this.settings.dimensions && this.settings.dimensions > 0) {
      body.dimensions = this.settings.dimensions;
    }
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + effectiveApiKey(this.settings),
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let text = "";
      try { text = await r.text(); } catch (e) { /* ignore */ }
      throw new Error("HTTP " + r.status + ": " + text.slice(0, 200));
    }
    const j = await r.json();
    return j.data.map((d: { embedding: number[] }) => d.embedding);
  }
}

// ============================================================================
// RerankClient:dashscope gte-rerank-v2 等 reranker —— hybrid 召回后给 query+doc
// pair 打分,精度比纯 embedding 距离高很多。专用于搜索路径。
//
// 注意:dashscope 兼容模式(/compatible-mode/v1)不带 rerank,需要走原生路径
// /api/v1/services/rerank/text-rerank/text-rerank。
// ============================================================================

class RerankClient {
  constructor(private settings: BijiSettings) {}

  isReady(): boolean {
    const s = this.settings;
    return !!(s.useRerank && s.rerankModel && s.endpoint && effectiveApiKey(s));
  }

  async rerank(query: string, documents: string[]): Promise<Array<{ index: number; score: number }>> {
    if (!documents.length) return [];

    // 把兼容模式 endpoint 转成原生 rerank endpoint(dashscope 专属)
    // 兼容模式:https://dashscope.aliyuncs.com/compatible-mode/v1
    // 原生 rerank: https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank
    const ep = this.settings.endpoint.replace(/\/+$/, "");
    let rerankUrl: string;
    if (ep.includes("dashscope.aliyuncs.com")) {
      rerankUrl = "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank";
    } else {
      throw new Error("当前 endpoint 不支持 rerank(仅 dashscope 提供 gte-rerank)");
    }

    const body = {
      model: this.settings.rerankModel,
      input: {
        query,
        documents,
      },
      parameters: {
        return_documents: false,
        top_n: documents.length,
      },
    };

    const r = await fetch(rerankUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + effectiveApiKey(this.settings),
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let text = "";
      try { text = await r.text(); } catch (e) { /* ignore */ }
      throw new Error("HTTP " + r.status + ": " + text.slice(0, 200));
    }
    const j = await r.json();
    const results = (j.output?.results || []) as Array<{ index: number; relevance_score: number }>;
    return results.map((x) => ({ index: x.index, score: x.relevance_score }));
  }
}

// ============================================================================
// LlmJudge:embedding 召回的 Top-K 候选 → LLM 判类型 + 写 reason
// ============================================================================

interface JudgeVerdict {
  idx: number;
  keep: boolean;
  type: MatchType;
  why: string;
}

// Prompt 在两个 provider 之间共享,只是 transport 不同
const JUDGE_SYSTEM =
  '你是"笔记拾荒者"——创作辅助插件的判定模块。\n\n' +
  "用户正在写一段东西,系统从他过去的笔记里召回了几条候选片段。" +
  "对每条候选,判定它和用户**正在写的内容**之间的关系(不是候选自身长什么样)。\n\n" +

  "【四种类型】\n\n" +

  "similar(相似):候选和用户在讲同一个角度,可以补充材料或换种说法。\n" +
  '  例:用户写"专注力很重要",候选写"深度工作让人状态升级"。\n\n' +

  "opposite(反向):候选的立场或结论 **跟用户正在写的相反** —— 不是\"换个角度\",而是\"反驳\"。能让用户停下来反思自己的判断。\n" +
  '  例:用户写"努力是唯一出路",候选写"努力的反面不是懒惰,是被动重复"。\n' +
  '  ⚠ 重要区分:候选自己句子里有"不是X而是Y"的自反句式 ≠ 反向。\n' +
  '     必须是候选的结论跟用户当下写的立场 **冲突**,才算反向。\n' +
  '     例如用户在写"亲密关系的痛苦",候选讲"独立思考不是模仿而是怀疑" ——\n' +
  '     虽然有"不是...而是"句式,但论点跟用户无关,这种 keep=false 或 similar。\n\n' +

  "case(案例):候选包含具体的人 / 事件 / 时间 / 数字 / 场景,可作为用户正在写的观点的具体证据或例子。\n" +
  '  例:用户写"独处的人更敏感",候选讲"去年我一个人住的那个月,听到楼上脚步都会出汗"。\n\n' +

  "quote(金句):候选是一句凝练判断,本身可独立成立(≤ 50 字),适合作标题/开头/结尾。不一定是名言,凡是\"画龙点睛\"那种。\n" +
  '  例:候选写"重复不是无聊,是把简单的事做到深刻"。\n\n' +

  "【keep=false 的情况】\n\n" +
  "候选只是主题词相近(都提到\"爱情\"或都谈\"工作\"),但讲的是完全不同的论点或场景 → keep=false 丢掉。\n" +
  "宁缺勿滥。质量比数量重要。\n\n" +

  "【输出 — 严格 JSON,不带 markdown 代码块、不带前后文】\n\n" +
  '{ "results": [\n' +
  '  {"idx": 0, "keep": true, "type": "opposite", "why": "你写X,这条说Y,正好反驳"},\n' +
  '  {"idx": 1, "keep": false, "type": "similar", "why": ""}\n' +
  '] }\n\n' +

  "【why 字段要求】\n" +
  "- 必须具体:点出候选和用户文本的**实际连接**(用户写了 X,这条说 Y)\n" +
  "- 禁止模板话术(如\"这条角度可以补充\"\"适合作标题\")\n" +
  "- 控制在 30 字以内\n" +
  "- 中文";

function buildJudgeUserMessage(query: string, candidates: { text: string }[]): string {
  return (
    "用户正在写:\n```\n" + query + "\n```\n\n候选片段:\n" +
    candidates.map((c, i) => `[${i}] ${c.text}`).join("\n\n")
  );
}

// 容错解析:模型偶尔用 ```json ... ``` 包裹,或前后带说明文字
function parseJudgeJson(content: string): JudgeVerdict[] {
  let parsed: { results?: JudgeVerdict[] };
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("LLM 返回的不是 JSON:" + content.slice(0, 120));
    parsed = JSON.parse(m[0]);
  }
  return (parsed.results || []).filter(
    (v): v is JudgeVerdict => v && typeof v.idx === "number"
  );
}

class LlmJudge {
  constructor(private settings: BijiSettings) {}

  isReady(): boolean {
    const s = this.settings;
    return !!(s.useLlmJudge && s.chatModel && effectiveChatEndpoint(s) && effectiveChatApiKey(s));
  }

  async judge(query: string, candidates: { text: string }[]): Promise<JudgeVerdict[]> {
    if (!candidates.length) return [];
    if (this.settings.chatProvider === "anthropic") {
      return this.judgeAnthropic(query, candidates);
    }
    return this.judgeOpenAi(query, candidates);
  }

  private async judgeOpenAi(query: string, candidates: { text: string }[]): Promise<JudgeVerdict[]> {
    const url = buildChatUrl(effectiveChatEndpoint(this.settings), "chat/completions");
    const body = {
      model: this.settings.chatModel,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: buildJudgeUserMessage(query, candidates) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    };
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + effectiveChatApiKey(this.settings),
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let text = "";
      try { text = await r.text(); } catch (e) { /* ignore */ }
      throw new Error("HTTP " + r.status + ": " + text.slice(0, 200));
    }
    const j = await r.json();
    const content: string = j.choices?.[0]?.message?.content || "{}";
    return parseJudgeJson(content);
  }

  private async judgeAnthropic(query: string, candidates: { text: string }[]): Promise<JudgeVerdict[]> {
    // Anthropic Messages API:不同于 OpenAI —— system 是顶层字段,header 是 x-api-key,response 走 content[].text
    // 没有 native response_format,靠 prompt 让 Claude 给纯 JSON;另用 assistant prefill 强制从 `{` 开始
    const url = buildChatUrl(effectiveChatEndpoint(this.settings), "messages");
    const body = {
      model: this.settings.chatModel,
      max_tokens: 1024,
      system: JUDGE_SYSTEM,
      messages: [
        { role: "user", content: buildJudgeUserMessage(query, candidates) },
        { role: "assistant", content: "{" }, // prefill — Claude 必然从 { 开始,response 里要补回来
      ],
      temperature: 0.2,
    };
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": effectiveChatApiKey(this.settings),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true", // Obsidian renderer 是 browser-like
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let text = "";
      try { text = await r.text(); } catch (e) { /* ignore */ }
      throw new Error("HTTP " + r.status + ": " + text.slice(0, 200));
    }
    const j = await r.json();
    const block = Array.isArray(j.content) ? j.content.find((b: { type?: string }) => b?.type === "text") : null;
    const text: string = block?.text || "";
    // prefill 的 `{` 不会出现在 response,要补回来
    return parseJudgeJson("{" + text);
  }
}

// ============================================================================
// LlmRefiner —— Relevance feedback 的"颠覆性"路径
//
// 不是把 query 向量和锚点向量加权平均(Rocchio)—— 那个跳不出邻近聚类。
// 这里让 LLM 看到 query / 锚点 / 上一轮未钉的卡片(负反馈),
// 推断用户真正在追问什么,**重写出一个全新的 query 文本**,再去 embed 召回。
//
// 每次 refine,query 文本在演化;多次迭代后搜索方向跟用户标记一起长出来。
// 同时显示 LLM 的 thought,让用户看到 AI 理解的方向 —— 不再是黑盒。
// ============================================================================

interface RefineVerdict {
  thought: string;       // 一句话:用户真正在追问什么(显示给用户)
  query: string;         // 改写后的 query,用于 re-embed 召回
  boost: string[];       // 召回后排序加分的关键词(0-5 个)
  exclude: string[];     // 召回后排序减分的关键词(0-5 个)
  conflict?: string;     // 锚点互相矛盾时,LLM 说出来 (可选)
}

const REFINER_SYSTEM = (
  "你是写作者的副脑。用户在做语义搜索 + 人工标记的迭代检索 (relevance feedback)。\n" +
  "他给你三样东西:原始 query / 他钉为'方向对'的锚点 chunks / 上一轮他看到了但没钉的 chunks(负反馈)。\n" +
  "\n" +
  "你的任务:**重写一个新的 query 文本**,跳出原 query 的字面,贴近用户真正在追问的方向。\n" +
  "这个新 query 会被拿去做 embedding 召回,所以**短而聚焦**远比长而周全重要。\n" +
  "\n" +
  "输出严格 JSON,不要 markdown 围栏:\n" +
  "{\n" +
  '  "thought":   "<30-60 字 · 用户真正在追问什么,点出原 query 没说出来的核心>",\n' +
  '  "query":     "<20-40 字 · 陈述句 · 必须包含原 query 的核心场景词 · 加上锚点的共同概念>",\n' +
  '  "boost":     ["关键概念词", ...],     // 2-4 个,锚点真正共有的核心概念\n' +
  '  "exclude":   ["不要这个方向", ...],    // 1-3 个,负反馈/锚点显式排除的方向\n' +
  '  "conflict":  "<可选 · 锚点互相矛盾时点出来,让用户裁决>"\n' +
  "}\n" +
  "\n" +
  "规则(违反会拉低召回质量):\n" +
  "1. **query 短**:20-40 字,**陈述句**,不要问句。Embedding 对长问句的表征远不如短陈述句精准。\n" +
  "2. **query 必须保留原 query 的核心场景**:原 query 是'感情'就要含'关系/感情';原 query 是'独处'就要含'独处'。不能另起话题。\n" +
  "3. **boost 是锚点真正共有的概念**,不是同义堆砌;1 个词比 5 个词强。\n" +
  "4. **演化方向 ≠ 完全跳出**:用户钉这些锚点是想'更精准',不是想换个话题。\n" +
  "\n" +
  "正例:\n" +
  "- 原 query: '感情' / 锚点: ['你不能改变对方', '改造的关系都是失败的'] / 负反馈: ['热烈情绪']\n" +
  "  → thought: '用户在追问的不是抽象的感情,而是亲密关系里如何放下改造对方的执念'\n" +
  "  → query:   '亲密关系中放下改造对方,转向自我调整'  (24 字 · 陈述句 · 含'关系')\n" +
  "  → boost:   ['接纳', '自我调整', '不改造']\n" +
  "  → exclude: ['控制', '激烈']\n" +
  "\n" +
  "反例(不要这样):\n" +
  "  → query:   '什么样的亲密关系能够容纳彼此的不完美、脆弱与人性真相,同时不引发自我攻击或过度索取?它如何让双方既放松又保有生命力?' ✗ 太长 · 问句 · 概念堆砌\n"
);

function buildRefinerUserMessage(args: { query: string; anchors: string[]; rejected?: string[] }): string {
  const lines: string[] = [];
  lines.push("原始 query:\n```\n" + args.query + "\n```");
  lines.push("");
  lines.push("用户钉为锚点(方向对):");
  args.anchors.forEach((a, i) => {
    // chunk text 可能很长,粗暴截到 280 字防止 prompt 膨胀
    const t = a.length > 280 ? a.slice(0, 280) + "…" : a;
    lines.push(`[${i + 1}] ${t}`);
  });
  if (args.rejected && args.rejected.length) {
    lines.push("");
    lines.push("用户看到了但没钉(负反馈,方向不对):");
    args.rejected.forEach((r, i) => {
      const t = r.length > 220 ? r.slice(0, 220) + "…" : r;
      lines.push(`[${i + 1}] ${t}`);
    });
  }
  return lines.join("\n");
}

function parseRefineJson(content: string): RefineVerdict {
  let parsed: Partial<RefineVerdict>;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("LLM 返回的不是 JSON:" + content.slice(0, 120));
    parsed = JSON.parse(m[0]);
  }
  return {
    thought:  (parsed.thought  || "").toString().trim(),
    query:    (parsed.query    || "").toString().trim(),
    boost:    Array.isArray(parsed.boost)   ? parsed.boost.filter((x: unknown) => typeof x === "string" && x.trim()) as string[] : [],
    exclude:  Array.isArray(parsed.exclude) ? parsed.exclude.filter((x: unknown) => typeof x === "string" && x.trim()) as string[] : [],
    conflict: parsed.conflict ? parsed.conflict.toString().trim() : undefined,
  };
}

class LlmRefiner {
  constructor(private settings: BijiSettings) {}

  isReady(): boolean {
    const s = this.settings;
    // 复用 LlmJudge 的 chat 配置 —— 同一个 chatModel / chatProvider 就行
    return !!(s.chatModel && effectiveChatEndpoint(s) && effectiveChatApiKey(s));
  }

  async refine(args: { query: string; anchors: string[]; rejected?: string[] }): Promise<RefineVerdict> {
    if (this.settings.chatProvider === "anthropic") {
      return this.callAnthropic(args);
    }
    return this.callOpenAi(args);
  }

  private async callOpenAi(args: { query: string; anchors: string[]; rejected?: string[] }): Promise<RefineVerdict> {
    const url = buildChatUrl(effectiveChatEndpoint(this.settings), "chat/completions");
    const body = {
      model: this.settings.chatModel,
      messages: [
        { role: "system", content: REFINER_SYSTEM },
        { role: "user",   content: buildRefinerUserMessage(args) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.15, // 压低,refine query 需要稳定 —— 太发散就成"换话题"了
    };
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + effectiveChatApiKey(this.settings),
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let text = "";
      try { text = await r.text(); } catch (e) { /* ignore */ }
      throw new Error("HTTP " + r.status + ": " + text.slice(0, 200));
    }
    const j = await r.json();
    const content: string = j.choices?.[0]?.message?.content || "{}";
    return parseRefineJson(content);
  }

  private async callAnthropic(args: { query: string; anchors: string[]; rejected?: string[] }): Promise<RefineVerdict> {
    const url = buildChatUrl(effectiveChatEndpoint(this.settings), "messages");
    const body = {
      model: this.settings.chatModel,
      max_tokens: 1024,
      system: REFINER_SYSTEM,
      messages: [
        { role: "user", content: buildRefinerUserMessage(args) },
        { role: "assistant", content: "{" },
      ],
      temperature: 0.15,
    };
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": effectiveChatApiKey(this.settings),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let text = "";
      try { text = await r.text(); } catch (e) { /* ignore */ }
      throw new Error("HTTP " + r.status + ": " + text.slice(0, 200));
    }
    const j = await r.json();
    const block = Array.isArray(j.content) ? j.content.find((b: { type?: string }) => b?.type === "text") : null;
    const text: string = block?.text || "";
    return parseRefineJson("{" + text);
  }
}

// ============================================================================
// EmbeddingStore:把 embedding 二进制存到独立的 embeddings.bin
//
// 原因:JSON 序列化 1000+ 个 2048 维 float 数组慢且占内存(~30MB 文本),改成
// 紧凑二进制后体积 ~70% 缩减,加载/写入快很多。data.json 只留小数据(settings,
// chunksByPath 等)。
//
// 格式:[count u32 LE][entries...],每条 entry [id_len u16 LE][id utf8][dim u16 LE][dim * float32 LE]
// ============================================================================

class EmbeddingStore {
  constructor(private plugin: BijiHuangzhePlugin) {}

  private binPath(): string {
    // manifest.dir 给出 ".obsidian/plugins/biji-huangzhe"
    return (this.plugin.manifest.dir ?? "") + "/embeddings.bin";
  }

  async load(): Promise<Map<string, number[]>> {
    const m = new Map<string, number[]>();
    const path = this.binPath();
    const adapter = this.plugin.app.vault.adapter;
    let buf: ArrayBuffer;
    try {
      if (!(await adapter.exists(path))) return m;
      buf = await adapter.readBinary(path);
    } catch (e) {
      console.warn("[拾荒者] embeddings.bin 读取失败,从空开始:", e);
      return m;
    }
    try {
      const view = new DataView(buf);
      let off = 0;
      const count = view.getUint32(off, true); off += 4;
      const dec = new TextDecoder("utf-8");
      for (let i = 0; i < count; i++) {
        const idLen = view.getUint16(off, true); off += 2;
        const id = dec.decode(new Uint8Array(buf, off, idLen)); off += idLen;
        const dim = view.getUint16(off, true); off += 2;
        const vec = new Array<number>(dim);
        for (let k = 0; k < dim; k++) {
          vec[k] = view.getFloat32(off, true); off += 4;
        }
        m.set(id, vec);
      }
    } catch (e) {
      console.warn("[拾荒者] embeddings.bin 解析失败,可能格式损坏:", e);
      return new Map();
    }
    return m;
  }

  async save(map: Map<string, number[]>): Promise<void> {
    // 先算总字节数,一次性分配 ArrayBuffer(比逐次扩容快)
    const enc = new TextEncoder();
    const idBytesList: Uint8Array[] = [];
    let total = 4; // count
    for (const [id, vec] of map) {
      const idBytes = enc.encode(id);
      idBytesList.push(idBytes);
      total += 2 + idBytes.length + 2 + vec.length * 4;
    }
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    let off = 0;
    view.setUint32(off, map.size, true); off += 4;
    let idx = 0;
    for (const [, vec] of map) {
      const idBytes = idBytesList[idx++];
      view.setUint16(off, idBytes.length, true); off += 2;
      new Uint8Array(buf, off, idBytes.length).set(idBytes); off += idBytes.length;
      view.setUint16(off, vec.length, true); off += 2;
      for (const v of vec) {
        view.setFloat32(off, v, true); off += 4;
      }
    }
    await this.plugin.app.vault.adapter.writeBinary(this.binPath(), buf);
  }

  async exists(): Promise<boolean> {
    return await this.plugin.app.vault.adapter.exists(this.binPath());
  }
}

// ============================================================================
// Indexer
// ============================================================================

class Indexer {
  chunksByPath = new Map<string, Chunk[]>();
  embeddings = new Map<string, number[]>();
  constructor(public plugin: BijiHuangzhePlugin) {}

  async indexFile(file: TFile): Promise<{ added: number; total: number }> {
    const content = await this.plugin.app.vault.cachedRead(file);
    const s = this.plugin.settings;
    const rawChunks = chunkNote(content, { min: s.chunkMin, max: s.chunkMax });
    const chunks: Chunk[] = rawChunks.map((c, i) => ({
      id: `${file.path}#${i}::${file.stat.mtime}`,
      notePath: file.path,
      noteTitle: file.basename,
      index: i,
      text: c.text,
      start: c.start,
      end: c.end,
    }));
    // 删旧 chunk 的 embedding(避免 stale)
    const old = this.chunksByPath.get(file.path) || [];
    let removedAny = false;
    for (const oc of old) if (!chunks.find((nc) => nc.id === oc.id)) {
      this.embeddings.delete(oc.id);
      removedAny = true;
    }
    this.chunksByPath.set(file.path, chunks);

    const missing = chunks.filter((ch) => !this.embeddings.has(ch.id));
    if (!missing.length || !this.plugin.embedClient.isReady()) {
      if (removedAny) this.plugin.markEmbeddingsDirty();
      return { added: 0, total: chunks.length };
    }
    const BATCH = 8;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const embs = await this.plugin.embedClient.embed(batch.map((ch) => ch.text));
      for (let j = 0; j < batch.length; j++) this.embeddings.set(batch[j].id, embs[j]);
    }
    this.plugin.markEmbeddingsDirty();
    return { added: missing.length, total: chunks.length };
  }

  removeFile(path: string) {
    const chunks = this.chunksByPath.get(path);
    if (chunks && chunks.length > 0) {
      for (const ch of chunks) this.embeddings.delete(ch.id);
      this.plugin.markEmbeddingsDirty();
    }
    this.chunksByPath.delete(path);
  }

  async indexAll(onProgress?: (done: number, total: number) => void): Promise<number> {
    const files = this.plugin.app.vault.getMarkdownFiles();
    console.log(`[拾荒者] indexAll: 找到 ${files.length} 个 .md 文件`);
    if (!files.length) {
      console.warn("[拾荒者] vault 里一个 .md 都没找到 — Obsidian 可能需要 Ctrl+R 重新扫描");
    }
    let added = 0;
    let totalChunks = 0;
    let i = 0;
    for (const f of files) {
      const r = await this.indexFile(f);
      added += r.added;
      totalChunks += r.total;
      if (r.total === 0) {
        console.warn(`[拾荒者] ${f.path} 切块结果 0 块(内容可能太短 < ${this.plugin.settings.chunkMin} 字)`);
      } else {
        console.log(`[拾荒者] ${f.path}: ${r.total} 块,新算 ${r.added}`);
      }
      i++;
      onProgress?.(i, files.length);
    }
    console.log(`[拾荒者] indexAll 完成:${files.length} 文件,${totalChunks} 块,新算 ${added} embedding`);
    return added;
  }

  getAllChunks(excludePath?: string): Chunk[] {
    const all: Chunk[] = [];
    for (const [path, chunks] of this.chunksByPath) {
      if (path === excludePath) continue;
      for (const ch of chunks) all.push(ch);
    }
    return all;
  }
}

// ============================================================================
// BM25:基于关键词的传统信息检索算法,跟 embedding 双路召回
//
// 为什么需要它:embedding 是"主题级",对短 query(几个字)抓不准 —— 搜"好的爱情"
// 可能错过含"好的爱情"字面的具体段落,反而被"虐恋"等同主题但论点无关的盖过。
// BM25 在字面命中上无敌,加上 embedding 做语义补充,两条腿走路。
// ============================================================================

class Bm25 {
  private idf = new Map<string, number>();
  private avgDocLen = 0;
  // 缓存每个 chunk 的 token 分布,避免每次搜索都重 tokenize
  private docTokenCount = new Map<string, Map<string, number>>();
  private docLens = new Map<string, number>();
  private static readonly K1 = 1.5;
  private static readonly B = 0.75;

  constructor(chunks: Chunk[]) {
    const docFreq = new Map<string, number>();
    let totalLen = 0;
    for (const ch of chunks) {
      const tokens = extractNgrams(ch.text);
      const tokenCount = new Map<string, number>();
      for (const t of tokens) tokenCount.set(t, (tokenCount.get(t) || 0) + 1);
      this.docTokenCount.set(ch.id, tokenCount);
      this.docLens.set(ch.id, tokens.length);
      totalLen += tokens.length;
      for (const t of tokenCount.keys()) docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
    this.avgDocLen = chunks.length > 0 ? totalLen / chunks.length : 1;
    const N = chunks.length;
    for (const [t, df] of docFreq) {
      // BM25 IDF:log((N - df + 0.5) / (df + 0.5) + 1) —— 标准平滑版,避免负值
      this.idf.set(t, Math.log((N - df + 0.5) / (df + 0.5) + 1));
    }
  }

  score(queryTokens: string[], chunkId: string): number {
    const tokenCount = this.docTokenCount.get(chunkId);
    const docLen = this.docLens.get(chunkId);
    if (!tokenCount || docLen === undefined) return 0;
    const lenNorm = 1 - Bm25.B + Bm25.B * docLen / this.avgDocLen;
    let score = 0;
    for (const qt of queryTokens) {
      const tf = tokenCount.get(qt) || 0;
      if (tf === 0) continue;
      const idf = this.idf.get(qt) || 0;
      if (idf <= 0) continue; // 烂大街的词(N/df 接近 1)不计分
      score += idf * (tf * (Bm25.K1 + 1)) / (tf + Bm25.K1 * lenNorm);
    }
    return score;
  }
}

// ============================================================================
// Matcher
// ============================================================================

class Matcher {
  constructor(private plugin: BijiHuangzhePlugin) {}

  // Hybrid 搜索:embedding(语义)+ BM25(关键词)双路召回,RRF 合并,note 级聚合。
  // 颠覆性改动:不再依赖单一 embedding 距离 —— BM25 抓字面命中,embedding 抓语义。
  async searchHybrid(query: string, hardCap = 20): Promise<MatchResult[]> {
    const s = this.plugin.settings;
    if (!this.plugin.embedClient.isReady()) return [];

    const chunks = this.plugin.indexer.getAllChunks(); // 不 exclude 任何 path
    const validChunks = chunks.filter((ch) => !this.plugin.hidden[ch.id]); // 仍尊重 hidden

    // ===== 1. embedding 召回 =====
    let queryEmb: number[];
    try {
      [queryEmb] = await this.plugin.embedClient.embed([query]);
    } catch (e) {
      throw new Error("embedding 失败:" + (e as Error).message);
    }
    const embedScores: Array<{ ch: Chunk; sim: number }> = [];
    for (const ch of validChunks) {
      const emb = this.plugin.indexer.embeddings.get(ch.id);
      if (!emb) continue;
      const sim = cosine(queryEmb, emb);
      embedScores.push({ ch, sim });
    }
    embedScores.sort((a, b) => b.sim - a.sim);

    // ===== 2. BM25 召回 =====
    const bm25 = new Bm25(validChunks);
    const queryTokens = extractNgrams(query);
    const bm25Scores: Array<{ ch: Chunk; bm25: number }> = [];
    for (const ch of validChunks) {
      const score = bm25.score(queryTokens, ch.id);
      if (score > 0) bm25Scores.push({ ch, bm25: score });
    }
    bm25Scores.sort((a, b) => b.bm25 - a.bm25);

    // ===== 3. RRF 合并(Reciprocal Rank Fusion)=====
    // 同一 chunk 在两个排名里的 1/(k+rank) 相加;k=60 是经典经验值。
    // 字面命中的 chunk 在 BM25 里排很前,语义近的在 embedding 里排很前 —— 两者都被加分。
    const RRF_K = 60;
    const TOP_N_PER_PATH = 100;
    const combined = new Map<string, { ch: Chunk; rrf: number; sim: number; bm25: number }>();

    embedScores.slice(0, TOP_N_PER_PATH).forEach((item, idx) => {
      combined.set(item.ch.id, {
        ch: item.ch,
        rrf: 1 / (RRF_K + idx + 1),
        sim: item.sim,
        bm25: 0,
      });
    });
    bm25Scores.slice(0, TOP_N_PER_PATH).forEach((item, idx) => {
      const existing = combined.get(item.ch.id);
      if (existing) {
        existing.rrf += 1 / (RRF_K + idx + 1);
        existing.bm25 = item.bm25;
      } else {
        combined.set(item.ch.id, {
          ch: item.ch,
          rrf: 1 / (RRF_K + idx + 1),
          sim: 0,
          bm25: item.bm25,
        });
      }
    });

    let merged = [...combined.values()].sort((a, b) => b.rrf - a.rrf);

    // ===== 3.5 Reranker:用 rerank 模型给 query+doc pair 精确打分,精度跳一档 =====
    // 拿 RRF top-N 送给 rerank,按相关度分数重排。失败 fallback 到 RRF 结果。
    const RERANK_TOP_N = 30;
    const rerankReady = this.plugin.rerankClient.isReady();
    console.log(`[拾荒者] hybrid search "${query}" — RRF candidates=${merged.length}, rerank ready=${rerankReady}`);
    if (rerankReady && merged.length > 1) {
      const candidates = merged.slice(0, RERANK_TOP_N);
      try {
        const rerankResults = await this.plugin.rerankClient.rerank(
          query,
          candidates.map((c) => c.ch.text)
        );
        if (rerankResults.length) {
          // 打详细日志:让用户在 Console 看到 rerank 真在跑 + top 5 实际分数
          console.log(`[拾荒者] rerank 完成,重排 ${rerankResults.length} 条候选。Top 8:`);
          rerankResults.slice(0, 8).forEach((r, i) => {
            const cand = candidates[r.index];
            const preview = cand?.ch.text.slice(0, 50).replace(/\n/g, " ") || "(?)";
            console.log(`  #${i + 1}  score=${r.score.toFixed(3)} | ${cand?.ch.noteTitle} | ${preview}...`);
          });

          const reranked = rerankResults
            .map((r) => {
              const cand = candidates[r.index];
              if (!cand) return null;
              return { ...cand, sim: r.score }; // 用 rerank score 覆盖 sim 字段
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
          const reranked_ids = new Set(reranked.map((r) => r.ch.id));
          const tail = merged.filter((m) => !reranked_ids.has(m.ch.id));
          merged = [...reranked, ...tail];
        } else {
          console.warn("[拾荒者] rerank 返回空结果,用 RRF");
        }
      } catch (e) {
        console.warn("[拾荒者] rerank 失败,用 RRF 结果:", e);
      }
    } else if (!rerankReady) {
      console.log("[拾荒者] rerank 未启用 / 未就绪 (检查 Settings → 触发与匹配 → 搜索用 Reranker 重排 是否开 + endpoint 是否 dashscope + API Key 配置)");
    }

    // ===== 4. Note 级软聚合:同一笔记最多展示 PER_NOTE_CAP 条 =====
    // 早期"每篇只 1 条"太严 —— 会把同一笔记里多个高相关段落压掉。
    // 现在每篇最多 3 条:既避免长笔记霸占整屏,又允许同笔记多段都出来。
    const PER_NOTE_CAP = 3;
    const noteCount = new Map<string, number>();
    const noteAgg: typeof merged = [];
    for (const m of merged) {
      const cnt = noteCount.get(m.ch.notePath) || 0;
      if (cnt >= PER_NOTE_CAP) continue;
      noteCount.set(m.ch.notePath, cnt + 1);
      noteAgg.push(m);
      if (noteAgg.length >= hardCap) break;
    }

    // ===== 5. 构造 MatchResult =====
    const querySet = new Set(queryTokens);
    return noteAgg.map((m) => {
      const chunkSet = new Set(extractNgrams(m.ch.text));
      const shared = [...querySet].filter((g) => chunkSet.has(g)).slice(0, 6);
      const type = detectType(m.ch.text, m.sim, s.reverseMinSim);
      return {
        chunkId: m.ch.id,
        text: m.ch.text,
        notePath: m.ch.notePath,
        noteTitle: m.ch.noteTitle,
        type,
        sim: m.sim, // 卡片仍展示 embedding sim(直观;BM25 分用户看不懂)
        shared,
        why: buildWhy(type, m.ch.text),
        snippet: pickRelevantSentence(m.ch.text, shared),
      };
    });
  }

  async match(
    query: string,
    excludePath?: string,
    skipAntiNoise = false,
    skipMinQuery = false,
    // relevance feedback / Rocchio:外部已经把 query embedding 和锚点 embedding 混好,传进来,
    // 跳过这里的 embed 调用。锚点的 chunkId 通过 excludeChunkIds 排掉,避免锚点又上榜。
    overrideEmb?: number[],
    excludeChunkIds?: Set<string>,
  ): Promise<MatchResult[]> {
    const s = this.plugin.settings;
    if (!skipMinQuery && query.length < s.minQueryChars) return [];
    if (!this.plugin.embedClient.isReady()) return [];

    let queryEmb: number[];
    if (overrideEmb) {
      queryEmb = overrideEmb;
    } else {
      try {
        [queryEmb] = await this.plugin.embedClient.embed([query]);
      } catch (e) {
        // 抛给 caller 决定怎么提示:autoTrigger 路径静默(状态条)、用户主动搜索弹 Notice。
        throw new Error("embedding 失败:" + (e as Error).message);
      }
    }

    const querySet = new Set(extractNgrams(query));
    const chunks = this.plugin.indexer.getAllChunks(excludePath);
    const now = Date.now();
    const dedupMs = s.dedupDays * 24 * 3600 * 1000;
    // 个性化:取用户偏好向量(冷启动 / 关闭时为 null,后续 rankSim 加分项跳过)
    const prefVec = this.plugin.getPreferenceVector();
    const prefWeight = s.personalizationStrength * 0.08; // 1 → 0.08;2 → 0.16
    const scored: { ch: Chunk; sim: number; rankSim: number }[] = [];
    for (const ch of chunks) {
      const emb = this.plugin.indexer.embeddings.get(ch.id);
      if (!emb) continue;
      if (this.plugin.hidden[ch.id]) continue;
      if (excludeChunkIds && excludeChunkIds.has(ch.id)) continue;

      // 反打扰:同一条 N 天内已展示过 → 跳过(antiNoise=false 或显式搜索时关掉)
      const lastShown = this.plugin.shown[ch.id];
      if (!skipAntiNoise && s.antiNoise && dedupMs > 0 && lastShown && now - lastShown < dedupMs) continue;

      // 反打扰:累计标过 ≥2 次"没用",N 天内拉黑(同上,显式搜索 skipAntiNoise=true 跳过)
      const fb = this.plugin.feedback[ch.id];
      if (!skipAntiNoise && s.antiNoise && fb && fb.useless >= 2 && dedupMs > 0 && now - fb.lastAt < dedupMs) continue;

      const sim = cosine(queryEmb, emb);
      if (sim < s.minSim) continue;

      // 排序权重(sim 字段保留原始相似度给卡片展示):
      // (a) per-chunk feedback:精确命中过的卡片直接加/减分
      // (b) 偏好向量:跟"过去标过有用的卡片主题相似"的也加分(关键的"个性化"飞轮)
      let rankSim = sim;
      if (fb) {
        rankSim += 0.05 * fb.useful;   // 之前是 0.02 太弱了,翻 2.5 倍
        rankSim -= 0.10 * fb.useless;  // 之前是 0.05,翻 2 倍
      }
      if (prefVec && prefWeight > 0) {
        const personal = cosine(prefVec, emb); // -1..+1
        rankSim += prefWeight * personal;
      }
      scored.push({ ch, sim, rankSim });
    }
    scored.sort((a, b) => b.rankSim - a.rankSim);
    if (!scored.length) return [];

    // ===== Reranker 接入:embedding 排好后,用 rerank 模型给 top-N 重排 =====
    // 跟搜索路径同样的 rerank 调用,提升卡片召回精度。失败 fallback 到 embedding 排序。
    if (this.plugin.rerankClient.isReady() && scored.length > 1) {
      const RERANK_TOP_N = Math.max(15, s.llmTopK * 2); // 取至少 15 个或 2 倍 llmTopK 送 rerank
      const candidates = scored.slice(0, RERANK_TOP_N);
      try {
        const rerankResults = await this.plugin.rerankClient.rerank(
          query,
          candidates.map((c) => c.ch.text)
        );
        if (rerankResults.length) {
          // 只更新 rankSim(排序用),保留原 cosine sim(展示给用户、fallback 阈值用)
          const reranked = rerankResults
            .map((r) => {
              const cand = candidates[r.index];
              if (!cand) return null;
              return { ch: cand.ch, sim: cand.sim, rankSim: r.score };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
          const rerankedIds = new Set(reranked.map((r) => r.ch.id));
          const tail = scored.filter((s) => !rerankedIds.has(s.ch.id));
          scored.length = 0;
          scored.push(...reranked, ...tail);
        }
      } catch (e) {
        console.warn("[拾荒者] match rerank 失败,用 embedding 排序:", e);
      }
    }

    // ===== 二段式:embedding 取 Top-K 送 LLM 判类型 + reason =====
    type Picked = { ch: Chunk; sim: number; type: MatchType; why: string };
    let picked: Picked[] = [];

    const useLlm = this.plugin.llmJudge.isReady();
    const llmCandidates = scored.slice(0, Math.max(s.llmTopK, s.topK));

    if (useLlm) {
      try {
        const verdicts = await this.plugin.llmJudge.judge(
          query,
          llmCandidates.map((c) => ({ text: c.ch.text }))
        );
        const allowed: MatchType[] = ["similar", "opposite", "case", "quote"];

        // 1. 收集所有 LLM 判 keep=true 的候选,按类型分组(候选已经按 rerank/sim 排好序)
        const byType = new Map<MatchType, Picked[]>();
        for (let i = 0; i < llmCandidates.length; i++) {
          const c = llmCandidates[i];
          const v = verdicts.find((x) => x.idx === i);
          if (!v || !v.keep) continue;
          const type: MatchType = allowed.includes(v.type) ? v.type : "similar";
          const why = (v.why || "").trim() || buildWhy(type, c.ch.text);
          if (!byType.has(type)) byType.set(type, []);
          byType.get(type)!.push({ ch: c.ch, sim: c.sim, type, why });
        }

        // 2. 类型多样性约束:轮流挑各类型 top 1,再轮挑 top 2,以此类推。
        //    优先顺序:反向(隐藏杀招) > 案例(具体证据) > 金句(画龙点睛) > 相似(基础补充)。
        //    每类型最多 2 个,避免同类型把屏幕占满。
        const PER_TYPE_CAP = 2;
        const typeOrder: MatchType[] = ["opposite", "case", "quote", "similar"];
        for (let round = 0; round < PER_TYPE_CAP && picked.length < s.topK; round++) {
          for (const t of typeOrder) {
            if (picked.length >= s.topK) break;
            const list = byType.get(t) || [];
            if (list[round]) picked.push(list[round]);
          }
        }
      } catch (e) {
        console.warn("[拾荒者] LLM 判定失败,退回启发式:", e);
        picked = []; // 强制走 fallback
      }
    }

    // Fallback:LLM 未启用 / 失败 / 全部 keep=false → 用原来的启发式
    if (!picked.length) {
      const top = scored[0];
      if (top) {
        const type = detectType(top.ch.text, top.sim, s.reverseMinSim);
        picked.push({ ch: top.ch, sim: top.sim, type, why: buildWhy(type, top.ch.text) });
      }
      const second = scored[1];
      if (second && second.sim >= s.minSimTop2 && picked.length < s.topK) {
        const type = detectType(second.ch.text, second.sim, s.reverseMinSim);
        picked.push({ ch: second.ch, sim: second.sim, type, why: buildWhy(type, second.ch.text) });
      }
    }

    return picked.map((p) => {
      const chunkSet = new Set(extractNgrams(p.ch.text));
      const shared = [...querySet].filter((g) => chunkSet.has(g)).slice(0, 6);
      return {
        chunkId: p.ch.id,
        text: p.ch.text,
        notePath: p.ch.notePath,
        noteTitle: p.ch.noteTitle,
        type: p.type,
        sim: p.sim,
        shared,
        why: p.why,
        snippet: pickRelevantSentence(p.ch.text, shared),
      };
    });
  }
}

// ============================================================================
// 右侧 ItemView
// ============================================================================

class BijiView extends ItemView {
  plugin: BijiHuangzhePlugin;
  cardStack!: HTMLElement;
  statusEl!: HTMLElement;
  refineBar!: HTMLElement;
  refiningIndicator!: HTMLElement;

  // Relevance feedback / LLM-rewrite:用户钉选觉得对的卡片,作为锚点重召回
  // 会话级状态,跨次召回累积;打开面板时清空
  private pinned: Map<string, MatchResult> = new Map();
  private refineThought: RefineVerdict | null = null;
  private refineThinking = false;

  constructor(leaf: WorkspaceLeaf, plugin: BijiHuangzhePlugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() { return VIEW_TYPE_BIJI; }
  getDisplayText() { return "笔记拾荒者"; }
  getIcon() { return "feather"; }

  async onOpen() {
    const c = this.containerEl.children[1] as HTMLElement;
    c.empty();
    c.addClass("biji-root");
    this.pinned.clear();

    const head = c.createDiv({ cls: "biji-head" });
    head.createSpan({ cls: "biji-title", text: "🪶 笔记拾荒者" });
    this.statusEl = head.createSpan({ cls: "biji-status" });

    // 语义搜索框 —— 输入文字按回车,直接搜全 vault(不需要在某个笔记里)
    this.renderSearchBar(c);

    // 锚点 refine bar(默认隐藏,只有 pinned 非空时显示)
    this.refineBar = c.createDiv({ cls: "biji-refine-bar is-hidden" });
    this.renderRefineBar();

    // 卡片堆叠包一层 wrap,提供 indicator 的定位坐标系
    // (不能直接挂在 .biji-root 上,否则居中会被 head/searchBar/refineBar 的高度推偏)
    const stackWrap = c.createDiv({ cls: "biji-stack-wrap" });
    this.cardStack = stackWrap.createDiv({ cls: "biji-stack" });
    this.renderEmpty();

    // refining indicator —— 浮在卡片区中央的"AI 召回中…"提示。
    // refine 期间旧卡片模糊淡出,这个指示器浮现,让用户知道"有事在发生",
    // 而不是面对空白屏 / 旧卡片视觉错配。
    this.refiningIndicator = stackWrap.createDiv({ cls: "biji-refining-indicator" });
    this.refiningIndicator.createDiv({ cls: "biji-refining-label", text: "AI · 召回中" });
    const dots = this.refiningIndicator.createDiv({ cls: "biji-refining-dots" });
    dots.createDiv({ cls: "biji-refining-dot" });
    dots.createDiv({ cls: "biji-refining-dot" });
    dots.createDiv({ cls: "biji-refining-dot" });
  }

  // refine 期间锁住旧卡片:模糊 + 淡出 + 失去交互,中央浮指示器
  setRefineInProgress(v: boolean) {
    if (!this.cardStack || !this.refiningIndicator) return;
    if (v) {
      this.cardStack.addClass("is-refining");
      this.refiningIndicator.addClass("is-active");
    } else {
      this.cardStack.removeClass("is-refining");
      this.refiningIndicator.removeClass("is-active");
    }
  }

  // ─── Relevance feedback / 锚点钉选 ────────────────────────────────
  togglePin(r: MatchResult): boolean {
    if (this.pinned.has(r.chunkId)) {
      this.pinned.delete(r.chunkId);
      this.renderRefineBar();
      return false;
    }
    this.pinned.set(r.chunkId, r);
    // 钉新锚点时清掉上次的 thought,提示用户"该再 refine 一次了"
    this.refineThought = null;
    this.renderRefineBar();
    return true;
  }

  isPinned(chunkId: string): boolean { return this.pinned.has(chunkId); }

  setRefineThinking(v: boolean) {
    this.refineThinking = v;
    this.renderRefineBar();
  }

  setRefineThought(v: RefineVerdict | null) {
    this.refineThought = v;
    this.renderRefineBar();
  }

  private renderRefineBar() {
    if (!this.refineBar) return;
    this.refineBar.empty();
    const n = this.pinned.size;
    if (n === 0) {
      this.refineBar.addClass("is-hidden");
      return;
    }
    this.refineBar.removeClass("is-hidden");

    // 顶行:锚点计数 + 操作按钮
    const topRow = this.refineBar.createDiv({ cls: "biji-refine-top" });
    const label = topRow.createSpan({ cls: "biji-refine-label" });
    label.setText(this.refineThinking
      ? `⭐ ${n} 锚点 · AI 正在重写 query…`
      : `⭐ ${n} 个锚点(最多用最近 6 个)`);

    const refineBtn = topRow.createEl("button", {
      cls: "biji-refine-go",
      text: this.refineThought ? "再细化 →" : "以这些再找 →",
    });
    refineBtn.disabled = this.refineThinking;
    refineBtn.onclick = () => this.plugin.runRefine([...this.pinned.values()]);

    const clearBtn = topRow.createEl("button", {
      cls: "biji-refine-clear",
      text: "清空",
    });
    clearBtn.onclick = () => {
      this.pinned.clear();
      this.refineThought = null;
      this.renderRefineBar();
      // 把已渲染卡片的 ⭐ 视觉状态清掉
      this.cardStack
        .querySelectorAll(".biji-pin.is-pinned")
        .forEach((el) => el.removeClass("is-pinned"));
    };

    // 第二行:AI thought + (可选)conflict 警告 + boost/exclude 标签
    if (this.refineThought) {
      const v = this.refineThought;
      if (v.thought) {
        const thoughtRow = this.refineBar.createDiv({ cls: "biji-refine-thought" });
        thoughtRow.createSpan({ cls: "biji-refine-thought-prefix", text: "AI · 理解" });
        thoughtRow.createSpan({ cls: "biji-refine-thought-text", text: v.thought });
      }
      if (v.query) {
        const qRow = this.refineBar.createDiv({ cls: "biji-refine-newquery" });
        qRow.createSpan({ cls: "biji-refine-newquery-prefix", text: "AI · 改写" });
        qRow.createSpan({ cls: "biji-refine-newquery-text", text: v.query });
      }
      if (v.conflict) {
        const cRow = this.refineBar.createDiv({ cls: "biji-refine-conflict" });
        cRow.setText("⚠ " + v.conflict);
      }
      if (v.boost.length || v.exclude.length) {
        const tags = this.refineBar.createDiv({ cls: "biji-refine-tags" });
        for (const b of v.boost)   tags.createSpan({ cls: "biji-refine-tag biji-refine-tag-boost",   text: "+ " + b });
        for (const x of v.exclude) tags.createSpan({ cls: "biji-refine-tag biji-refine-tag-exclude", text: "− " + x });
      }
    }
  }

  pinnedIds(): string[] { return [...this.pinned.keys()]; }
  pinnedAnchors(): MatchResult[] { return [...this.pinned.values()]; }
  unpinnedFromLast(lastResults: MatchResult[]): MatchResult[] {
    return lastResults.filter((r) => !this.pinned.has(r.chunkId));
  }

  private renderSearchBar(c: HTMLElement) {
    const bar = c.createDiv({ cls: "biji-search-bar" });
    const input = bar.createEl("input", {
      cls: "biji-search-input",
      attr: {
        type: "text",
        placeholder: "想找点什么…(语义搜索,不需要精确词)",
      },
    });
    const btn = bar.createEl("button", { cls: "biji-search-btn", text: "🔍" });
    const clearBtn = bar.createEl("button", { cls: "biji-search-clear", text: "×" });

    const trigger = () => {
      const q = input.value.trim();
      if (!q) return;
      this.plugin.runSearch(q);
    };
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); trigger(); }
      else if (e.key === "Escape") { input.value = ""; this.renderEmpty(); this.setStatus(""); }
    });
    btn.onclick = trigger;
    clearBtn.onclick = () => {
      input.value = "";
      input.focus();
      this.renderEmpty();
      this.setStatus("");
    };
  }

  async onClose() {}

  setStatus(text: string) { this.statusEl?.setText(text); }

  renderEmpty() {
    this.cardStack.empty();
    const p = this.plugin;
    const empty = this.cardStack.createDiv({ cls: "biji-empty" });

    // 分情况引导:API 未配置 / 索引未跑 / 召回为空 三种状态分别给不同文案 + 操作提示
    if (!p.embedClient?.isReady()) {
      empty.createDiv({ cls: "biji-empty-main", text: "还没配置 API" });
      empty.createDiv({ cls: "biji-empty-hint", text: "设置 → 笔记拾荒者 → API Key" });
      return;
    }
    if ((p.indexer?.chunksByPath.size ?? 0) === 0) {
      empty.createDiv({ cls: "biji-empty-main", text: "vault 还没索引" });
      empty.createDiv({ cls: "biji-empty-hint", text: "Ctrl+P → 索引整个 vault" });
      return;
    }
    empty.createDiv({ cls: "biji-empty-main", text: "等你写下值得被想起的字句。" });
  }

  // 笔记修改时间 → "3 个月前你写过的"——拾荒感的灵魂
  private formatRelTime(notePath: string): string {
    const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return "";
    const mtime = file.stat?.mtime;
    if (!mtime) return "";
    const diffMs = Date.now() - mtime;
    if (diffMs < 0) return "";
    const days = Math.floor(diffMs / 86400000);
    if (days < 1)   return "今天";
    if (days < 2)   return "昨天";
    if (days < 7)   return `${days} 天前`;
    if (days < 30)  return `${Math.floor(days / 7)} 周前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return `${Math.floor(days / 365)} 年前`;
  }

  showResults(results: MatchResult[], mode: "normal" | "search" = "normal") {
    // 任何新结果到来都解除 refine 锁定 —— 容器透明度恢复 + indicator 隐藏
    this.setRefineInProgress(false);
    this.cardStack.empty();
    if (!results.length) {
      this.cardStack.createDiv({
        cls: "biji-empty",
        text: mode === "search" ? "没找到。试试换个词。" : "这一段还没有可拾起的旧笔记。\n继续写。",
      });
      return;
    }
    for (const r of results) this.renderCard(r, mode);
  }

  private renderCard(r: MatchResult, mode: "normal" | "search" = "normal") {
    const card = this.cardStack.createDiv({ cls: "biji-card" });
    card.dataset.type = r.type;

    const head = card.createDiv({ cls: "biji-card-head" });
    head.createSpan({ cls: "biji-dot" });
    head.createSpan({ cls: "biji-type", text: TYPE_LABEL[r.type] });
    head.createSpan({ cls: "biji-sim", text: `${Math.round(r.sim * 100)}%` });

    // ⭐ 钉选锚点(relevance feedback):用户挑出"觉得对"的卡片做下一轮 refine
    const pin = head.createSpan({ cls: "biji-pin" });
    pin.setText("★");
    pin.setAttr("title", "钉为锚点,基于它再找一次");
    if (this.isPinned(r.chunkId)) pin.addClass("is-pinned");
    pin.onclick = (e) => {
      e.stopPropagation();
      const on = this.togglePin(r);
      pin.toggleClass("is-pinned", on);
    };

    const close = head.createSpan({ cls: "biji-close", text: "×" });

    // 关闭动画:slide-right + fade,280ms 后 remove —— 比直接 .remove() 优雅
    const dismiss = () => {
      card.addClass("biji-dismissing");
      setTimeout(() => card.remove(), 280);
    };
    close.onclick = dismiss;

    const snippet = card.createDiv({ cls: "biji-snippet" });
    const snipText = pickRelevantSnippet(r.text, r.shared);
    this.fillWithHighlights(snippet, snipText, r.shared);

    const why = card.createDiv({ cls: "biji-why" });
    this.fillWithHighlights(why, r.why, r.shared);

    const foot = card.createDiv({ cls: "biji-foot" });
    foot.createSpan({ cls: "biji-src", text: r.noteTitle });
    const relTime = this.formatRelTime(r.notePath);
    if (relTime) foot.createSpan({ cls: "biji-time", text: relTime });
    const open = foot.createSpan({ cls: "biji-open", text: "看原文 →" });
    open.onclick = () => this.plugin.openSource(r.notePath, r.chunkId, r.snippet);

    // 搜索结果不渲染反馈按钮 —— 搜索是探索,不是 personalized 召回反馈
    if (mode === "search") return;

    const actions = card.createDiv({ cls: "biji-actions" });
    // 有用 / 没用:只记反馈,卡片保留(用户还要继续看 / 复制 / 看原文)
    const bUseful = actions.createEl("button", { cls: "biji-btn biji-useful", text: "有用" });
    bUseful.onclick = () => {
      this.plugin.markUseful(r.chunkId, true);
      bUseful.setText("✓ 已标");
      bUseful.addClass("biji-marked");
      (bUseful as HTMLButtonElement).disabled = true;
      // 取消另一边的标记
      bUseless.removeClass("biji-marked");
      (bUseless as HTMLButtonElement).disabled = false;
      bUseless.setText("没用");
    };
    const bUseless = actions.createEl("button", { cls: "biji-btn biji-useless", text: "没用" });
    bUseless.onclick = () => {
      this.plugin.markUseful(r.chunkId, false);
      bUseless.setText("✕ 已标");
      bUseless.addClass("biji-marked");
      (bUseless as HTMLButtonElement).disabled = true;
      bUseful.removeClass("biji-marked");
      (bUseful as HTMLButtonElement).disabled = false;
      bUseful.setText("有用");
    };
    // 别再提醒:这个明确是"我不想再看到这条" → 卡片消失
    const bMute = actions.createEl("button", { cls: "biji-btn", text: "别再提醒" });
    bMute.onclick = () => { this.plugin.hideChunk(r.chunkId); dismiss(); };
  }

  // 安全填充 + 高亮 shared 词(用 DOM API,避免 innerHTML 注入)
  private fillWithHighlights(el: HTMLElement, text: string, shared: string[]) {
    el.empty();
    if (!shared?.length) { el.setText(text); return; }
    const words = [...shared].filter(Boolean).sort((a, b) => b.length - a.length);
    let remaining = text;
    let safety = 200;
    while (remaining && safety-- > 0) {
      let bestIdx = -1, bestWord = "";
      for (const w of words) {
        const i = remaining.indexOf(w);
        if (i >= 0 && (bestIdx < 0 || i < bestIdx)) { bestIdx = i; bestWord = w; }
      }
      if (bestIdx < 0) { el.appendText(remaining); break; }
      if (bestIdx > 0) el.appendText(remaining.slice(0, bestIdx));
      const mark = el.createEl("mark", { text: bestWord });
      void mark;
      remaining = remaining.slice(bestIdx + bestWord.length);
    }
  }
}

// ============================================================================
// Settings Tab
// ============================================================================

class BijiSettingTab extends PluginSettingTab {
  plugin: BijiHuangzhePlugin;
  constructor(app: App, plugin: BijiHuangzhePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "笔记拾荒者" });
    containerEl.createEl("p", {
      text: "Embedding API 配置。默认 dashscope(中文最优)。也支持 OpenAI 兼容的任何 endpoint。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("API Endpoint")
      .setDesc("OpenAI 兼容的 endpoint。云端:dashscope(中文优)、OpenAI 等。本地完全离线:Ollama(http://localhost:11434/v1)。")
      .addText((t) => t
        .setPlaceholder("https://dashscope.aliyuncs.com/compatible-mode/v1")
        .setValue(this.plugin.settings.endpoint)
        .onChange(async (v) => { this.plugin.settings.endpoint = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Model")
      .addText((t) => t
        .setPlaceholder("text-embedding-v4")
        .setValue(this.plugin.settings.model)
        .onChange(async (v) => { this.plugin.settings.model = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Dimensions")
      .setDesc("embedding 维度,0 表示用模型默认。dashscope v4 推荐 2048。")
      .addText((t) => t
        .setPlaceholder("2048")
        .setValue(String(this.plugin.settings.dimensions || ""))
        .onChange(async (v) => {
          this.plugin.settings.dimensions = v.trim() ? parseInt(v.trim(), 10) || 0 : 0;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("API Key")
      .setDesc('⚠️ 明文存 data.json。vault 同步到 iCloud / Dropbox / git 会包含此文件。推荐用环境变量 BIJI_API_KEY 代替(详见 README)。')
      .addText((t) => {
        t.inputEl.type = "password";
        t
          .setPlaceholder("sk-... 或留空走环境变量")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => { this.plugin.settings.apiKey = v.trim(); await this.plugin.saveSettings(); });
      });

    // 实时显示 env 状态
    const envStatus = containerEl.createEl("p", { cls: "setting-item-description" });
    envStatus.style.marginLeft = "0";
    envStatus.style.marginBottom = "1.4em";
    if (hasEnvApiKey()) {
      envStatus.setText("✓ 已检测到环境变量 BIJI_API_KEY,正在使用环境变量(覆盖此处设置)。可以把上面的 API Key 留空,避免明文写入 data.json。");
      envStatus.style.color = "var(--text-success)";
    } else {
      envStatus.setText("未检测到环境变量 BIJI_API_KEY。当前用 Settings 里的 key(明文存盘)。设环境变量后重启 Obsidian 生效。");
      envStatus.style.color = "var(--text-muted)";
    }

    containerEl.createEl("h3", { text: "触发与匹配" });

    new Setting(containerEl)
      .setName("写作时自动召回卡片")
      .setDesc("开 = 你写笔记停 2 秒后右侧自动浮现卡片。关 = 只通过搜索框 / 右键 / 命令显式触发(默认,不打扰写作)。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.autoTrigger)
        .onChange(async (v) => {
          this.plugin.settings.autoTrigger = v;
          await this.plugin.saveSettings();
          new Notice(v ? "自动召回 已开" : "自动召回 已关 — 用搜索框 / 右键触发", 2000);
        }));

    new Setting(containerEl)
      .setName("搜索用 Reranker 重排(精度高一档)")
      .setDesc("开 = 搜索时 hybrid 召回 top 30 后,用 dashscope rerank 模型(gte-rerank-v2)精确重排。每次搜索多 ¥0.005,慢 0.5 秒,但精度明显提升。只对搜索框生效,不影响写作自动召回。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.useRerank)
        .onChange(async (v) => {
          this.plugin.settings.useRerank = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Rerank Model")
      .setDesc("dashscope 推荐 gte-rerank-v2(最新,中文最强)。其他可选:gte-rerank。")
      .addText((t) => t
        .setPlaceholder("gte-rerank-v2")
        .setValue(this.plugin.settings.rerankModel)
        .onChange(async (v) => { this.plugin.settings.rerankModel = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("触发延迟(ms)")
      .setDesc("停顿多少毫秒后触发自动召回(仅自动召回开启时生效)。")
      .addText((t) => t
        .setValue(String(this.plugin.settings.triggerDelayMs))
        .onChange(async (v) => { this.plugin.settings.triggerDelayMs = +v || 2000; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("最低相关度")
      .setDesc("0-1。低于此分的候选不召回。")
      .addText((t) => t
        .setValue(String(this.plugin.settings.minSim))
        .onChange(async (v) => { this.plugin.settings.minSim = +v || 0.45; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("反向类型门槛(启发式)")
      .setDesc("LLM 关掉时才生效。sim 高于此分才允许标'反向'。低于则降级'相似'。默认 0.7。")
      .addText((t) => t
        .setValue(String(this.plugin.settings.reverseMinSim))
        .onChange(async (v) => { this.plugin.settings.reverseMinSim = +v || 0.7; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("每次展示卡片数 (topK)")
      .setDesc("一次召回展示几张卡片。默认 2。觉得参考不够 → 3-5;觉得太杂 → 1。最大 10。")
      .addText((t) => t
        .setValue(String(this.plugin.settings.topK))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.topK = isNaN(n) || n < 1 ? 2 : Math.min(n, 10);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("第二张卡片的相关度门槛(启发式)")
      .setDesc("LLM 关掉时才生效。第二张候选的 sim 必须 ≥ 此分。默认 0.6。觉得第二张总不出 → 调到 0.5;觉得第二张总很杂 → 0.65+。")
      .addText((t) => t
        .setValue(String(this.plugin.settings.minSimTop2))
        .onChange(async (v) => { this.plugin.settings.minSimTop2 = +v || 0.6; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "LLM 二段式判定" });
    containerEl.createEl("p", {
      text: "embedding 召回后,让 LLM 看你正在写的内容和候选,判定类型(相似/反向/案例/金句)并给出具体 reason。关掉则退回正则启发式(反向/案例靠候选自身的句式判,why 是模板话术)。",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("启用 LLM 二段式")
      .addToggle((t) => t
        .setValue(this.plugin.settings.useLlmJudge)
        .onChange(async (v) => { this.plugin.settings.useLlmJudge = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Provider")
      .setDesc('OpenAI 兼容(dashscope qwen / OpenAI / Ollama 等)或 Anthropic(Claude)。切换后会重新加载设置页。')
      .addDropdown((d) => d
        .addOption("openai-compat", "OpenAI 兼容 (qwen / OpenAI / Ollama)")
        .addOption("anthropic", "Anthropic (Claude)")
        .setValue(this.plugin.settings.chatProvider)
        .onChange(async (v) => {
          const oldProvider = this.plugin.settings.chatProvider;
          const newProvider = v as "openai-compat" | "anthropic";
          this.plugin.settings.chatProvider = newProvider;

          // 切到不同 provider 时,清空 chat endpoint + key —— 避免把旧 vendor 的 key 误带到新 endpoint(典型坑:simpleai 的 sk-xxx 留在那儿,切回 dashscope 后 401)
          if (oldProvider !== newProvider) {
            this.plugin.settings.chatEndpoint = "";
            this.plugin.settings.chatApiKey = "";
          }

          // model 也跟着重置(已知系列模型 qwen-*/claude-* 都视为可替换;用户自定义的不动)
          const m = this.plugin.settings.chatModel;
          const isKnownQwen = /^qwen-/.test(m);
          const isKnownClaude = /^claude-/.test(m);
          const shouldResetModel = !m ||
            (newProvider === "anthropic" && isKnownQwen) ||
            (newProvider === "openai-compat" && isKnownClaude);
          if (shouldResetModel) {
            this.plugin.settings.chatModel = newProvider === "anthropic"
              ? "claude-haiku-4-5-20251001"
              : "qwen-turbo";
          }

          await this.plugin.saveSettings();
          this.display(); // 重新渲染,字段/placeholder/提示跟着变
        }));

    const isAnthropic = this.plugin.settings.chatProvider === "anthropic";

    new Setting(containerEl)
      .setName("Chat Endpoint")
      .setDesc(isAnthropic
        ? "Anthropic 官方:https://api.anthropic.com(留空走默认)。中转服务(如 simpleai)填 https://key.simpleai.com.cn,带不带 /v1 都行。"
        : "留空 = 用上面的 API Endpoint(向后兼容)。也可单独填(chat 走 OpenAI 而 embedding 走 dashscope 等)。")
      .addText((t) => t
        .setPlaceholder(isAnthropic ? "https://api.anthropic.com" : "(留空 = 用上面的 API Endpoint)")
        .setValue(this.plugin.settings.chatEndpoint)
        .onChange(async (v) => { this.plugin.settings.chatEndpoint = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Chat API Key")
      .setDesc(isAnthropic
        ? "Anthropic API key(sk-ant-...)。建议用环境变量 BIJI_ANTHROPIC_API_KEY 代替。"
        : "留空 = 用上面的 API Key(向后兼容,如果你 embedding 和 chat 共用同一 vendor)。")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(isAnthropic ? "sk-ant-... 或留空走环境变量" : "(留空 = 用上面的 API Key)")
         .setValue(this.plugin.settings.chatApiKey)
         .onChange(async (v) => { this.plugin.settings.chatApiKey = v.trim(); await this.plugin.saveSettings(); });
      });

    if (isAnthropic) {
      const envHint = containerEl.createEl("p", { cls: "setting-item-description" });
      envHint.style.marginBottom = "1.4em";
      if (hasEnvAnthropicKey()) {
        envHint.setText("✓ 已检测到环境变量 BIJI_ANTHROPIC_API_KEY,正在使用环境变量。可以把上面的 Chat API Key 留空。");
        envHint.style.color = "var(--text-success)";
      } else {
        envHint.setText("未检测到环境变量 BIJI_ANTHROPIC_API_KEY。当前用 Settings 里的 Chat API Key(明文存盘)。");
        envHint.style.color = "var(--text-muted)";
      }
    }

    new Setting(containerEl)
      .setName("Chat Model")
      .setDesc(isAnthropic
        ? "Claude 推荐 claude-haiku-4-5-20251001(快、便宜)或 claude-sonnet-4-6(质量好,贵)。"
        : "dashscope 推荐 qwen-turbo(便宜快)或 qwen-plus(质量好)。任何 OpenAI 兼容 chat 接口都能用。")
      .addText((t) => t
        .setPlaceholder(isAnthropic ? "claude-haiku-4-5-20251001" : "qwen-turbo")
        .setValue(this.plugin.settings.chatModel)
        .onChange(async (v) => { this.plugin.settings.chatModel = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("送 LLM 的候选数")
      .setDesc("embedding 取 Top N 个候选送 LLM,LLM 再筛出最终展示几条(由 topK 控制,默认 2)。默认 5。")
      .addText((t) => t
        .setValue(String(this.plugin.settings.llmTopK))
        .onChange(async (v) => { this.plugin.settings.llmTopK = +v || 5; await this.plugin.saveSettings(); }));

    // ========================================================================
    // 反打扰
    // ========================================================================
    containerEl.createEl("h3", { text: "反打扰" });
    containerEl.createEl("p", {
      text: '冷却限制频率,去重防止反复浮现同一条,专注模式可一键暂停。卡片上累计标 2 次"没用"后,该条进入 N 天短期黑名单。',
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("反打扰过滤")
      .setDesc('开 = 启用冷却 / 7 天去重 / "没用累计 2 次"黑名单。关 = 全部跳过,只走纯 embedding + LLM 决定召回。"别再提醒"hidden 不受影响(那是显式 opt-out)。**默认关**,新装即用全开放;真正稳定写作期再打开。')
      .addToggle((t) => t
        .setValue(this.plugin.settings.antiNoise)
        .onChange(async (v) => {
          this.plugin.settings.antiNoise = v;
          await this.plugin.saveSettings();
          new Notice(v ? "反打扰已开启 — 冷却/去重/拉黑生效" : "反打扰已关闭 — 全候选池可见", 2500);
        }));

    new Setting(containerEl)
      .setName("两次卡片之间的冷却(秒)")
      .setDesc("一次召回后,这么久内不再自动触发(手动拾一下不受限)。0 = 关闭冷却。默认 60。")
      .addText((t) => t
        .setValue(String(Math.round(this.plugin.settings.cooldownMs / 1000)))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.cooldownMs = (isNaN(n) || n < 0 ? 60 : n) * 1000;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("同一条不重复天数")
      .setDesc("同一条 chunk 在 N 天内不再召回。0 = 关闭去重。默认 7。")
      .addText((t) => t
        .setValue(String(this.plugin.settings.dedupDays))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.dedupDays = isNaN(n) || n < 0 ? 7 : n;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("专注模式")
      .setDesc('打开后完全暂停召回。也可 Ctrl+P 搜"切换专注模式"快速切。')
      .addToggle((t) => t
        .setValue(this.plugin.settings.focusMode)
        .onChange(async (v) => {
          this.plugin.settings.focusMode = v;
          await this.plugin.saveSettings();
          if (v) {
            this.plugin.view?.setStatus("专注模式");
            this.plugin.view?.renderEmpty();
          } else {
            this.plugin.view?.setStatus("就绪");
          }
        }));

    new Setting(containerEl)
      .setName("个性化强度(偏好向量)")
      .setDesc('用你标过"有用/没用"的卡片算一个偏好向量,给"主题相似于你过去喜欢的"候选加分(带 30 天半衰期)。0=关闭(纯检索);1=适中(推荐);2=激进(强烈跟着你的标记走)。冷启动 0 反馈时无效。')
      .addDropdown((d) => d
        .addOption("0", "0 · 关闭")
        .addOption("1", "1 · 适中(推荐)")
        .addOption("2", "2 · 激进")
        .setValue(String(this.plugin.settings.personalizationStrength))
        .onChange(async (v) => {
          const n = parseInt(v, 10) as 0 | 1 | 2;
          this.plugin.settings.personalizationStrength = (n === 0 || n === 1 || n === 2) ? n : 1;
          this.plugin.invalidatePrefVec();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("清空展示历史 / 反馈")
      .setDesc("清掉 N 天去重记录和有用/没用反馈(包括偏好向量)。卡片上的「别再提醒」不受影响。")
      .addButton((b) => b
        .setButtonText("清空")
        .setWarning()
        .onClick(async () => {
          this.plugin.shown = {};
          this.plugin.feedback = {};
          this.plugin.invalidatePrefVec();
          await this.plugin.persist();
          new Notice("已清空展示历史和反馈");
          this.display();
        }));

    containerEl.createEl("h3", { text: "索引 / 切块" });

    new Setting(containerEl)
      .setName("Chunk 最小字数")
      .setDesc("一段笔记被切成 chunk 的最小长度。小 = 单一观点单独成块,rerank 能锁定具体句子。推荐 60。")
      .addText((t) => t
        .setValue(String(this.plugin.settings.chunkMin))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.chunkMin = isNaN(n) || n < 20 ? 60 : Math.min(n, 1000);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Chunk 最大字数")
      .setDesc("一个 chunk 不超过这个字数。大 = 上下文充足但语义混杂,小 = 论点单一但失去上下文。推荐 200。改完点下面「重新切块并索引」生效。")
      .addText((t) => t
        .setValue(String(this.plugin.settings.chunkMax))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.chunkMax = isNaN(n) || n < 60 ? 200 : Math.min(n, 5000);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("索引整个 vault(增量)")
      .setDesc("遍历所有 .md,切块,计算 embedding。增量:已索引的不重跑。第一次用必须跑。")
      .addButton((b) => b
        .setButtonText("开始索引")
        .setCta()
        .onClick(async () => {
          if (!this.plugin.embedClient.isReady()) {
            new Notice("请先填好 endpoint / model / API key");
            return;
          }
          b.setButtonText("正在索引...");
          try {
            const added = await this.plugin.indexer.indexAll((done, total) => {
              b.setButtonText(`${done}/${total}`);
            });
            await this.plugin.persist();
            new Notice(`索引完成,新计算 ${added} 块 embedding。`);
          } catch (e) {
            new Notice("索引失败:" + (e as Error).message);
          }
          b.setButtonText("开始索引");
        }));

    new Setting(containerEl)
      .setName("用新切块参数重新索引(全量)")
      .setDesc("改了 chunkMin/Max 后必点 —— 清空旧 chunks + embeddings,按新参数重新切块并算 embedding。会消耗一些 API 额度(几万 token)。")
      .addButton((b) => b
        .setButtonText("重新切块并索引")
        .setWarning()
        .onClick(async () => {
          if (!this.plugin.embedClient.isReady()) {
            new Notice("请先填好 endpoint / model / API key");
            return;
          }
          b.setButtonText("清空中...");
          this.plugin.indexer.embeddings.clear();
          this.plugin.indexer.chunksByPath.clear();
          this.plugin.markEmbeddingsDirty();
          await this.plugin.flush();
          b.setButtonText("重新索引中...");
          try {
            const added = await this.plugin.indexer.indexAll((done, total) => {
              b.setButtonText(`${done}/${total}`);
            });
            await this.plugin.flush();
            new Notice(`重新切块完成,新算 ${added} 块 embedding。`);
          } catch (e) {
            new Notice("重新索引失败:" + (e as Error).message);
          }
          b.setButtonText("重新切块并索引");
        }));

    new Setting(containerEl)
      .setName("清空索引")
      .setDesc("删除所有缓存的 embedding。慎用。")
      .addButton((b) => b
        .setButtonText("清空")
        .setWarning()
        .onClick(async () => {
          this.plugin.indexer.embeddings.clear();
          this.plugin.indexer.chunksByPath.clear();
          this.plugin.markEmbeddingsDirty(); // 同时重写 .bin(空文件)
          await this.plugin.flush(); // 立即写入,避免用户清完立刻关 Obsidian
          new Notice("已清空索引。");
        }));

    // ========================================================================
    // "别再提醒"管理:列出所有已隐藏的卡片,可逐条/一键恢复
    // ========================================================================
    containerEl.createEl("h3", { text: "已隐藏的卡片" });

    const hiddenIds = Object.keys(this.plugin.hidden)
      .filter((k) => this.plugin.hidden[k])
      .reverse(); // 最近隐藏的在最上面

    if (hiddenIds.length === 0) {
      containerEl.createEl("p", {
        text: '暂无。点了卡片的「别再提醒」后会出现在这里,可以逐条恢复。',
        cls: "setting-item-description",
      });
    } else {
      new Setting(containerEl)
        .setName(`共 ${hiddenIds.length} 条`)
        .setDesc("最近隐藏的在最上面。可以逐条恢复,也可以一键全部恢复。")
        .addButton((b) => b
          .setButtonText("全部恢复")
          .setWarning()
          .onClick(async () => {
            this.plugin.hidden = {};
            await this.plugin.persist();
            new Notice("已全部恢复");
            this.display();
          }));

      for (const id of hiddenIds) {
        // chunkId 格式:`${path}#${index}::${mtime}`,反查 indexer 拿来源信息
        const sep = id.lastIndexOf("::");
        const pathAndIdx = sep > 0 ? id.slice(0, sep) : id;
        const hash = pathAndIdx.lastIndexOf("#");
        const path = hash > 0 ? pathAndIdx.slice(0, hash) : pathAndIdx;
        const idxStr = hash > 0 ? pathAndIdx.slice(hash + 1) : "0";

        const chunks = this.plugin.indexer.chunksByPath.get(path) || [];
        // 先精确 id 匹配,匹配不上再退到 path+index(笔记被改后 mtime 变,id 对不上)
        let ch = chunks.find((c) => c.id === id);
        if (!ch) ch = chunks[parseInt(idxStr, 10) || 0];

        const title = ch?.noteTitle ||
          path.split("/").pop()?.replace(/\.md$/, "") ||
          "(unknown)";
        const preview = ch
          ? (ch.text.length > 90 ? ch.text.slice(0, 90) + "…" : ch.text)
          : "(来源已变,可能笔记被改/删/重命名)";

        new Setting(containerEl)
          .setName(title)
          .setDesc(preview)
          .addButton((b) => b
            .setButtonText("恢复")
            .onClick(async () => {
              delete this.plugin.hidden[id];
              await this.plugin.persist();
              new Notice("已恢复");
              this.display();
            }));
      }
    }
  }
}

// ============================================================================
// 主 Plugin
// ============================================================================

export default class BijiHuangzhePlugin extends Plugin {
  settings!: BijiSettings;
  embedClient!: EmbedClient;
  llmJudge!: LlmJudge;
  llmRefiner!: LlmRefiner;
  rerankClient!: RerankClient;
  embeddingStore!: EmbeddingStore;
  indexer!: Indexer;
  matcher!: Matcher;
  hidden: Record<string, boolean> = {};
  shown: Record<string, number> = {};                              // chunkId → 最后一次展示时间戳(去重)
  feedback: Record<string, { useful: number; useless: number; lastAt: number }> = {};
  lastShowAt = 0;                                                  // 上次卡片展示时间(冷却,仅内存)
  view: BijiView | null = null;

  // 写盘节流(markDirty/flush 机制)
  private dirty = false;
  private embeddingsDirty = false; // embeddings.bin 单独跟踪,避免无变化时也重写 30MB+
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistInflight: Promise<void> | null = null;
  private static readonly PERSIST_DEBOUNCE_MS = 2000;

  private triggerDebounced!: (editor: Editor, file: TFile | null) => void;

  // 文件级索引节流:vault.modify 高频触发时(用户连续打字 / 频繁保存),
  // 同一文件只在停止 INDEX_DEBOUNCE_MS 之后才真正索引一次。避免狂烧 embedding API。
  private indexDebouncers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly INDEX_DEBOUNCE_MS = 3000;

  // 底栏状态条(Obsidian status bar)— 在不打开拾荒面板时也能感知插件状态
  private statusBarItem: HTMLElement | null = null;
  private errorCount = 0;

  // "清空所有索引"命令的二次确认窗口(ms 时间戳;< now 则未触发过)
  private clearArmedUntil = 0;

  // 最近一次召回 / 搜索的结果 —— 用于"复制最后召回"命令 / refine 锚点搜索
  lastResults: MatchResult[] = [];
  lastQuery: string = "";

  // Relevance feedback:每轮最多用最近钉的 N 个锚点,防过拟合 + 防 prompt 膨胀
  static readonly REFINE_MAX_ANCHORS = 6;

  // 偏好向量缓存(Rocchio centroid of useful − 0.5 × useless,带时间衰减):
  // 用户长期"有用/没用"反馈聚合成一个向量,用于给"主题相似于他过去喜欢的"候选加分。
  // 维度跟着 settings.dimensions:换 embedding 模型后会自动失效重算。
  private prefVecCache: { vec: number[]; dim: number; computedAt: number } | null = null;
  private static readonly PREF_VEC_HALFLIFE_DAYS = 30; // 30 天前的反馈权重衰减到一半
  invalidatePrefVec() { this.prefVecCache = null; }

  // 算 / 取偏好向量。冷启动(0 反馈)或个性化关掉时返回 null。
  // 缓存有效期:5 分钟(防止每次 match 都重算 N×D 的求和)
  getPreferenceVector(): number[] | null {
    if (this.settings.personalizationStrength <= 0) return null;
    const targetDim = this.settings.dimensions;
    const now = Date.now();
    if (this.prefVecCache &&
        this.prefVecCache.dim === targetDim &&
        now - this.prefVecCache.computedAt < 5 * 60 * 1000) {
      return this.prefVecCache.vec;
    }

    const halfLifeMs = BijiHuangzhePlugin.PREF_VEC_HALFLIFE_DAYS * 24 * 3600 * 1000;
    let posSum: number[] | null = null;
    let posWeight = 0;
    let negSum: number[] | null = null;
    let negWeight = 0;
    for (const [chunkId, fb] of Object.entries(this.feedback)) {
      if (!fb || (fb.useful === 0 && fb.useless === 0)) continue;
      const emb = this.indexer.embeddings.get(chunkId);
      if (!emb || emb.length !== targetDim) continue;
      // 时间衰减:lastAt 越久远权重越低,30 天前 = 0.5,60 天前 ≈ 0.25
      const ageMs = Math.max(0, now - fb.lastAt);
      const decay = Math.pow(0.5, ageMs / halfLifeMs);
      const u = fb.useful * decay;
      const n = fb.useless * decay;
      if (u > 0) {
        if (!posSum) posSum = new Array(targetDim).fill(0);
        for (let i = 0; i < targetDim; i++) posSum[i] += u * emb[i];
        posWeight += u;
      }
      if (n > 0) {
        if (!negSum) negSum = new Array(targetDim).fill(0);
        for (let i = 0; i < targetDim; i++) negSum[i] += n * emb[i];
        negWeight += n;
      }
    }
    if (!posSum && !negSum) { this.prefVecCache = null; return null; }

    const vec = new Array(targetDim).fill(0);
    if (posSum && posWeight > 0) {
      for (let i = 0; i < targetDim; i++) vec[i] += posSum[i] / posWeight;
    }
    if (negSum && negWeight > 0) {
      // 反向贡献只取 0.5 权重(没用是较弱信号)
      for (let i = 0; i < targetDim; i++) vec[i] -= 0.5 * negSum[i] / negWeight;
    }
    this.prefVecCache = { vec, dim: targetDim, computedAt: now };
    return vec;
  }

  async onload() {
    // 1. 加载持久数据
    const data = ((await this.loadData()) as Record<string, unknown>) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (data.settings as Partial<BijiSettings>) || {});
    this.hidden = (data.hidden as Record<string, boolean>) || {};
    this.shown = (data.shown as Record<string, number>) || {};
    this.feedback = (data.feedback as typeof this.feedback) || {};

    // 2. 实例化模块
    this.embedClient = new EmbedClient(this.settings);
    this.llmJudge = new LlmJudge(this.settings);
    this.llmRefiner = new LlmRefiner(this.settings);
    this.rerankClient = new RerankClient(this.settings);
    this.embeddingStore = new EmbeddingStore(this);
    this.indexer = new Indexer(this);
    this.matcher = new Matcher(this);

    // 3. 填充 indexer:chunks 走 data.json,embeddings 走独立 .bin
    const chunksByPath = (data.chunksByPath as Record<string, Chunk[]>) || {};
    for (const k in chunksByPath) this.indexer.chunksByPath.set(k, chunksByPath[k]);

    // 优先从 embeddings.bin 加载;data.json 里的旧 embeddings 字段做一次性迁移
    const fromBin = await this.embeddingStore.load();
    for (const [k, v] of fromBin) this.indexer.embeddings.set(k, v);

    const legacyEmbeddings = (data.embeddings as Record<string, number[]>) || {};
    const legacyCount = Object.keys(legacyEmbeddings).length;
    if (legacyCount > 0) {
      console.log(`[拾荒者] 检测到旧 data.json 含 ${legacyCount} 条 embedding,迁移到 embeddings.bin…`);
      for (const k in legacyEmbeddings) {
        if (!this.indexer.embeddings.has(k)) this.indexer.embeddings.set(k, legacyEmbeddings[k]);
      }
      try {
        await this.embeddingStore.save(this.indexer.embeddings);
        new Notice(`笔记拾荒者:embeddings 已迁移到独立文件(${this.indexer.embeddings.size} 条)`, 4500);
        // 立即写一次 data.json(不再含 embeddings 字段),避免用户立刻关 Obsidian 时迁移没落地
        this.dirty = true;
        await this.flush();
      } catch (e) {
        console.warn("[拾荒者] 迁移失败,旧字段仍保留在 data.json:", e);
      }
    }

    // 4. 注册设置 + View + 底栏状态条
    this.addSettingTab(new BijiSettingTab(this.app, this));

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("biji-statusbar");
    this.statusBarItem.onclick = () => this.showStatus();
    this.refreshStatusBar();

    this.registerView(VIEW_TYPE_BIJI, (leaf) => {
      const v = new BijiView(leaf, this);
      this.view = v;
      return v;
    });

    // 5. 命令
    this.addCommand({
      id: "open-biji-view",
      name: "打开拾荒面板",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "index-vault",
      name: "索引整个 vault",
      callback: async () => {
        if (!this.embedClient.isReady()) {
          new Notice("请先配置 API(设置 → 笔记拾荒者 → API Key)");
          return;
        }
        new Notice("开始索引...");
        this.errorCount = 0;
        try {
          const added = await this.indexer.indexAll((d, t) => {
            this.view?.setStatus(`索引中 ${d}/${t}`);
            this.setStatusBarBusy(`索引 ${d}/${t}`);
          });
          await this.persist();
          new Notice(`完成,新计算 ${added} 块。`);
          this.view?.setStatus("就绪");
        } catch (e) {
          console.error("[拾荒者] indexAll 失败:", e);
          new Notice("索引失败:" + (e as Error).message);
          this.view?.setStatus("索引失败");
        }
        this.refreshStatusBar();
      },
    });
    this.addCommand({
      id: "refine-with-pins",
      name: "以钉选的锚点再找一次(AI 改写 query)",
      callback: () => {
        if (!this.view) { new Notice("先打开拾荒面板"); return; }
        const pins = this.view.pinnedAnchors();
        if (!pins.length) { new Notice("先在卡片上点 ★ 钉几张觉得对的"); return; }
        this.runRefine(pins);
      },
    });
    this.addCommand({
      id: "show-status",
      name: "查看索引状态",
      callback: () => this.showStatus(),
    });
    this.addCommand({
      id: "clear-index",
      name: "清空所有索引(需二次确认)",
      callback: () => this.clearAllIndex(),
    });
    this.addCommand({
      id: "manual-pick",
      name: "手动拾一下(有选中就用选中)",
      editorCallback: (editor, ctx) => {
        const file = ctx.file;
        const sel = editor.getSelection ? editor.getSelection() : "";
        const override = sel && sel.trim().length >= this.settings.minQueryChars ? sel : undefined;
        this.runMatch(editor, file?.path, true, override); // force=true 绕开冷却
      },
    });
    this.addCommand({
      id: "toggle-focus-mode",
      name: "切换专注模式(暂停/恢复召回)",
      callback: async () => {
        this.settings.focusMode = !this.settings.focusMode;
        await this.saveSettings();
        if (this.settings.focusMode) {
          this.view?.setStatus("专注模式");
          this.view?.renderEmpty();
          new Notice("专注模式 已开 — 召回暂停");
        } else {
          this.view?.setStatus("就绪");
          new Notice("专注模式 已关 — 召回恢复");
        }
      },
    });
    this.addCommand({
      id: "toggle-anti-noise",
      name: "切换反打扰(冷却 / 7天去重 / useless 黑名单)",
      callback: async () => {
        this.settings.antiNoise = !this.settings.antiNoise;
        await this.saveSettings();
        new Notice(this.settings.antiNoise
          ? "反打扰 已开 — 冷却 / 7天去重 / 拉黑 生效"
          : "反打扰 已关 — 不限制召回(测试调阈值时建议关)");
      },
    });
    this.addCommand({
      id: "toggle-auto-trigger",
      name: "切换自动召回(写作时停顿 N 秒自动拾)",
      callback: async () => {
        this.settings.autoTrigger = !this.settings.autoTrigger;
        await this.saveSettings();
        new Notice(this.settings.autoTrigger
          ? `自动召回 已开 — 停笔 ${this.settings.triggerDelayMs / 1000}s 后自动拾`
          : "自动召回 已关 — 只走显式触发(搜索框 / 手动拾 / 右键)");
      },
    });
    this.addCommand({
      id: "reindex-current",
      name: "重新索引当前笔记",
      editorCallback: async (_editor, ctx) => {
        if (!this.embedClient.isReady()) {
          new Notice("请先配置 API");
          return;
        }
        const file = ctx.file;
        if (!file) { new Notice("当前没有打开的笔记"); return; }
        // 取消任何 pending 的 debounce —— 立即重算
        const pending = this.indexDebouncers.get(file.path);
        if (pending) { clearTimeout(pending); this.indexDebouncers.delete(file.path); }
        // 强制重算:删掉旧 chunk 再 indexFile
        this.indexer.removeFile(file.path);
        try {
          const r = await this.indexer.indexFile(file);
          await this.persist();
          this.refreshStatusBar();
          new Notice(`✓ 已重新索引 ${file.basename}(${r.total} 块,新算 ${r.added})`);
        } catch (e) {
          this.recordError("重新索引失败", file.path, e);
          new Notice("重新索引失败:" + (e as Error).message);
        }
      },
    });
    this.addCommand({
      id: "copy-last-results",
      name: "复制最后召回的卡片(纯文本)",
      callback: async () => {
        if (!this.lastResults.length) {
          new Notice("还没有可复制的召回结果");
          return;
        }
        // 复制成简洁的纯文本格式:每条一节,带类型 + 出处 + snippet + why
        const block = this.lastResults.map((r) => {
          const typeLabel = TYPE_LABEL[r.type];
          return `[${typeLabel} · ${Math.round(r.sim * 100)}%] 《${r.noteTitle}》\n${r.snippet}\n— ${r.why}`;
        }).join("\n\n");
        try {
          await navigator.clipboard.writeText(block);
          new Notice(`✓ 已复制 ${this.lastResults.length} 条卡片到剪贴板`);
        } catch (e) {
          console.error("[拾荒者] 剪贴板写入失败:", e);
          new Notice("复制失败:" + (e as Error).message);
        }
      },
    });

    // 6. 监听编辑器(autoTrigger=true 时才自动召回;默认关闭,避免打扰写作)
    this.rebuildDebouncer();
    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      if (!this.settings.autoTrigger) return;
      if (info instanceof MarkdownView) {
        this.triggerDebounced(editor, info.file);
      }
    }));

    // 6.5 右键菜单:任何长度的选中都显示菜单项;长度太短点击时给 Notice 提示
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, info) => {
      const sel = editor.getSelection ? editor.getSelection() : "";
      if (!sel || !sel.trim()) return; // 没选中就不加
      const trimmed = sel.trim();
      // 不用 instanceof MarkdownView —— editor-menu 的 info 在某些场景是 MarkdownFileInfo,
      // instanceof 会 false 导致 file=null → excludePath 失效 → 召回当前文件自己。直接读 file 字段。
      const file = (info as { file?: TFile | null })?.file ?? null;
      menu.addItem((item) => {
        item.setTitle("🪶 用选中拾一下")
          .setIcon("feather")
          .onClick(() => {
            if (trimmed.length < this.settings.minQueryChars) {
              new Notice(
                `选中只有 ${trimmed.length} 字,embedding 抓不准。建议选完整一句或一段(${this.settings.minQueryChars}+ 字)。`,
                3500
              );
            }
            this.runMatch(editor, file?.path, true, sel); // force=true 绕开冷却
          });
      });
    }));

    // 7. 监听 vault 文件变化(增量索引)
    this.registerEvent(this.app.vault.on("create", async (f) => {
      if (!(f instanceof TFile) || f.extension !== "md") return;
      if (!this.embedClient.isReady()) return;
      try {
        await this.indexer.indexFile(f);
        await this.persist();
        this.refreshStatusBar();
      } catch (e) {
        this.recordError("索引新文件失败", f.path, e);
      }
    }));
    // modify 走 per-file debounce — 连续打字时只在停笔后才索引一次
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (!(f instanceof TFile) || f.extension !== "md") return;
      if (!this.embedClient.isReady()) return;
      this.scheduleReindex(f);
    }));
    this.registerEvent(this.app.vault.on("delete", async (f) => {
      if (!(f instanceof TFile) || f.extension !== "md") return;
      // 取消任何 pending 的 reindex
      const pending = this.indexDebouncers.get(f.path);
      if (pending) { clearTimeout(pending); this.indexDebouncers.delete(f.path); }
      this.indexer.removeFile(f.path);
      await this.persist();
      this.refreshStatusBar();
    }));
    this.registerEvent(this.app.vault.on("rename", async (f, oldPath) => {
      if (!(f instanceof TFile) || f.extension !== "md") return;
      const pending = this.indexDebouncers.get(oldPath);
      if (pending) { clearTimeout(pending); this.indexDebouncers.delete(oldPath); }
      this.indexer.removeFile(oldPath);
      if (!this.embedClient.isReady()) return;
      try {
        await this.indexer.indexFile(f);
        await this.persist();
        this.refreshStatusBar();
      } catch (e) {
        this.recordError("索引重命名文件失败", f.path, e);
      }
    }));

    // 8. 启动时自动打开 view
    this.app.workspace.onLayoutReady(() => this.activateView());
  }

  onunload() {
    // 取消所有 pending 的 reindex —— 避免文件已删/已 unload 后还跑
    for (const t of this.indexDebouncers.values()) clearTimeout(t);
    this.indexDebouncers.clear();

    // 关闭前最后一次写盘。Obsidian unload 会给异步操作一些时间完成。
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) {
      this.flush().catch((e) => console.warn("[拾荒者] onunload flush 失败:", e));
    }
  }

  // ─── per-file 索引节流 ────────────────────────────────────────────────
  // modify 事件每个文件可能 1 秒内触发数次(自动保存 + 用户打字),用 setTimeout
  // 收口:同一 path 在 INDEX_DEBOUNCE_MS 内的所有 modify 合并成一次 indexFile。
  private scheduleReindex(f: TFile) {
    const path = f.path;
    const existing = this.indexDebouncers.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      this.indexDebouncers.delete(path);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return; // 文件被改名/删了 — 放弃
      try {
        await this.indexer.indexFile(file);
        await this.persist();
        this.refreshStatusBar();
      } catch (e) {
        this.recordError("索引失败", path, e);
      }
    }, BijiHuangzhePlugin.INDEX_DEBOUNCE_MS);
    this.indexDebouncers.set(path, timer);
  }

  // ─── status bar 反馈 ─────────────────────────────────────────────────
  // Obsidian 右下角小条;不打开拾荒面板时也能感知插件状态(就绪/索引中/错误/未配置)。
  refreshStatusBar() {
    if (!this.statusBarItem) return;
    const sb = this.statusBarItem;
    sb.removeAttribute("data-kind");
    if (!this.embedClient?.isReady()) {
      sb.setText("🪶 未配置");
      sb.setAttr("title", "笔记拾荒者:未配置 API — 点这里看状态");
      sb.dataset.kind = "warn";
      return;
    }
    if (this.errorCount > 0) {
      sb.setText(`🪶 失败 ×${this.errorCount}`);
      sb.setAttr("title", `笔记拾荒者:最近 ${this.errorCount} 次索引/召回失败 — 控制台 Ctrl+Shift+I 看详情`);
      sb.dataset.kind = "error";
      return;
    }
    const indexed = this.indexer?.chunksByPath.size ?? 0;
    const embeds = this.indexer?.embeddings.size ?? 0;
    sb.setText(`🪶 ${indexed} 篇 · ${embeds}`);
    sb.setAttr("title", `笔记拾荒者:已索引 ${indexed} 篇笔记,共 ${embeds} 个 embedding chunk — 点这里看状态`);
    sb.dataset.kind = "ok";
  }

  setStatusBarBusy(text: string) {
    if (!this.statusBarItem) return;
    this.statusBarItem.setText(`🪶 ${text}`);
    this.statusBarItem.setAttr("title", `笔记拾荒者:${text}`);
    this.statusBarItem.dataset.kind = "busy";
  }

  private recordError(label: string, path: string, e: unknown) {
    console.error(`[拾荒者] ${label}:`, path, e);
    this.errorCount++;
    this.refreshStatusBar();
  }

  // ─── 查看索引状态命令 ─────────────────────────────────────────────────
  showStatus() {
    const vaultFiles = this.app.vault.getMarkdownFiles().length;
    const indexedFiles = this.indexer?.chunksByPath.size ?? 0;
    const chunks = this.indexer
      ? [...this.indexer.chunksByPath.values()].reduce((s, c) => s + c.length, 0)
      : 0;
    const embeds = this.indexer?.embeddings.size ?? 0;
    const hidden = Object.keys(this.hidden).length;
    const shown = Object.keys(this.shown).length;
    const apiOk = this.embedClient?.isReady() ?? false;
    const rerankOk = this.rerankClient?.isReady() ?? false;
    const llmOk = this.llmJudge?.isReady() ?? false;
    const errs = this.errorCount;
    const lines = [
      `📊 笔记拾荒者`,
      `Vault: ${vaultFiles} 篇 .md`,
      `已索引: ${indexedFiles} 篇 / ${chunks} 块 / ${embeds} embedding`,
      `Embedding API: ${apiOk ? "✓" : "✗ 未配置"}`,
      `Rerank: ${rerankOk ? "✓" : "—"}  ·  LLM judge: ${llmOk ? "✓" : "—"}`,
      hidden ? `隐藏: ${hidden} 条` : "",
      shown ? `已展示去重: ${shown} 条` : "",
      errs ? `⚠ 索引错误: ${errs} 次(看控制台)` : "",
    ].filter(Boolean);
    new Notice(lines.join("\n"), 10000);
  }

  // ─── 清空所有索引(二次确认)──────────────────────────────────────────
  async clearAllIndex() {
    const c = this.indexer?.chunksByPath.size ?? 0;
    const e = this.indexer?.embeddings.size ?? 0;
    if (!c && !e) {
      new Notice("索引已经是空的");
      return;
    }
    const now = Date.now();
    if (this.clearArmedUntil < now) {
      this.clearArmedUntil = now + 8000;
      new Notice(`⚠ 即将清空 ${c} 篇 / ${e} embedding。8 秒内再点一次确认。`, 8000);
      return;
    }
    this.clearArmedUntil = 0;
    this.indexer.chunksByPath.clear();
    this.indexer.embeddings.clear();
    this.errorCount = 0;
    this.markEmbeddingsDirty();
    await this.flush();
    this.refreshStatusBar();
    this.view?.setStatus("");
    this.view?.renderEmpty();
    new Notice(`✓ 已清空索引(原 ${c} 篇 / ${e} embedding)`);
  }

  private rebuildDebouncer() {
    this.triggerDebounced = debounce(
      (editor: Editor, file: TFile | null) => {
        // editor-change 触发时,有选中(且够长)优先用选中作 query
        const sel = editor.getSelection ? editor.getSelection() : "";
        const override = sel && sel.trim().length >= this.settings.minQueryChars ? sel : undefined;
        this.runMatch(editor, file?.path, false, override);
      },
      this.settings.triggerDelayMs,
      true
    );
  }

  // 语义搜索:不依赖 editor,直接接受 query,跳过反打扰过滤(显式搜索)
  async runSearch(query: string) {
    const q = query.trim();
    if (q.length < 2) {
      this.view?.setStatus("查询太短");
      return;
    }
    if (this.settings.focusMode) {
      this.view?.setStatus("专注模式 — 召回已暂停");
      return;
    }
    this.view?.setStatus(`搜索中(${q.length} 字)…`);
    try {
      // 搜索走 Hybrid 路径:embedding + BM25 双路召回 + RRF 合并 + note 级聚合
      // 不调 LLM(快 + 免费),hardCap 20 条
      const results = await this.matcher.searchHybrid(q, 20);
      this.lastResults = results;
      this.lastQuery = q;
      this.view?.setStatus(`找到 ${results.length} 条`);
      this.view?.showResults(results, "search"); // 搜索模式:卡片不渲染反馈按钮
      // 成功一次,清除累计的失败计数(算用户视角"现在没问题了")
      if (this.errorCount > 0) { this.errorCount = 0; this.refreshStatusBar(); }
      // 注意:不更新 lastShowAt 和 shown —— 搜索是探索行为,不污染反打扰记录
    } catch (e) {
      // 用户主动搜索,失败给 Notice 反馈(autoTrigger 的 runMatch 路径才静默)
      console.error("[拾荒者] 搜索失败:", e);
      new Notice("搜索失败:" + (e as Error).message, 4000);
      this.view?.setStatus("搜索失败");
      this.errorCount++;
      this.refreshStatusBar();
    }
  }

  async runMatch(editor: Editor, excludePath?: string, force = false, overrideQuery?: string) {
    // 反打扰:专注模式直接返回
    if (this.settings.focusMode) {
      this.view?.setStatus("专注模式 — 召回已暂停");
      return;
    }
    // 反打扰:冷却时间内不再触发(force=true 绕开;antiNoise=false 整套反打扰关掉时也绕开)
    if (!force && this.settings.antiNoise && this.settings.cooldownMs > 0 &&
        Date.now() - this.lastShowAt < this.settings.cooldownMs) {
      const remain = Math.ceil((this.settings.cooldownMs - (Date.now() - this.lastShowAt)) / 1000);
      this.view?.setStatus(`冷却中 · ${remain}s`);
      return;
    }

    // Query 提取:overrideQuery(选中) > editor 自动取光标 ±200 字
    // 旧版用"最后两段",对"光标在文档中间改东西"或"两段语义跨度大"场景不准
    // 新版直接以光标为中心,前后各 200 字,信号长度稳定 + 抓到光标实际所处的语境
    const usingSelection = !!(overrideQuery && overrideQuery.trim());
    let ctx: string;
    if (usingSelection) {
      ctx = overrideQuery!.trim();
    } else {
      const cursor = editor.getCursor();
      const all = editor.getValue();
      const cursorOffset = editor.posToOffset(cursor);
      const SIDE = 200;
      const start = Math.max(0, cursorOffset - SIDE);
      const end = Math.min(all.length, cursorOffset + SIDE);
      ctx = all.slice(start, end).trim();
    }
    // minQueryChars 只卡自动触发;显式选中(usingSelection)不卡 —— 用户自己决定查多短
    if (!usingSelection && ctx.length < this.settings.minQueryChars) {
      this.view?.setStatus("再写几句就会触发");
      return;
    }
    if (ctx.length < 2) {
      // 极端保护:总得有点东西可查
      this.view?.setStatus("查询太短");
      return;
    }
    this.view?.setStatus(usingSelection ? `用选中匹配中(${ctx.length} 字)…` : "匹配中…");
    try {
      const results = await this.matcher.match(ctx, excludePath);
      this.lastResults = results;
      this.lastQuery = ctx;
      if (results.length) {
        // 反打扰:记录展示时间(用于冷却 + N 天去重)
        const now = Date.now();
        this.lastShowAt = now;
        for (const r of results) this.shown[r.chunkId] = now;
        await this.persist();
      }
      this.view?.setStatus(`召回 ${results.length} 条`);
      this.view?.showResults(results);
      // 成功调用清错误计数(用户视角:现在没问题)
      if (this.errorCount > 0) { this.errorCount = 0; this.refreshStatusBar(); }
    } catch (e) {
      // autoTrigger / 手动拾 / 右键拾 —— 全走这里。被动场景不弹 Notice,只状态条提示。
      console.error("[拾荒者] 匹配失败:", e);
      this.view?.setStatus("匹配失败 — 看底栏");
      this.errorCount++;
      this.refreshStatusBar();
    }
  }

  // Relevance feedback —— LLM 重写 query 的"演化式"路径
  //
  // 跟 Rocchio 向量平均不同:不是在向量空间里加权混合(跳不出邻近聚类),
  // 而是把 query / 锚点 / 上一轮未钉的卡片(负反馈)交给 LLM,让它
  // **重写一个全新的 query 文本**,跳出原 query 的字面表达。每次 refine,
  // query 文本都在演化,搜索方向跟用户的标记一起长出来。
  //
  // 防过拟合:最多用最近钉的 MAX_ANCHORS 个锚点;LLM prompt 显式检查冲突,
  // 矛盾时在 thought 里点出来让用户裁决。

  // boost / exclude 关键词后处理:命中 boost +0.08 / 命中 exclude -0.15。
  // LLM 已经分析出锚点共有的核心概念,它们的权重应该足以真正改变排序,
  // 不只做"微调"。否则 LLM 给的关键词等于白做。
  private reweightByConcepts(results: MatchResult[], boost: string[], exclude: string[]): MatchResult[] {
    if (!boost.length && !exclude.length) return results;
    const scored = results.map((r) => {
      let s = r.sim;
      for (const w of boost)   if (w && r.text.includes(w)) s += 0.08;
      for (const w of exclude) if (w && r.text.includes(w)) s -= 0.15;
      return { r, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.map((x) => x.r);
  }

  async runRefine(anchors: MatchResult[]) {
    if (!this.embedClient.isReady()) {
      new Notice("请先配置 embedding API");
      return;
    }
    if (!anchors.length) {
      new Notice("先在卡片上点 ★ 钉几张觉得对的,再来再找");
      return;
    }
    if (!this.llmRefiner.isReady()) {
      new Notice("锚点搜索需要 chat API(设置 → 笔记拾荒者 → LLM 二段式判定 → 填 chat 模型 + key)");
      return;
    }
    const query = (this.lastQuery || "").trim();
    if (!query) {
      new Notice("没有可参考的 query — 先触发一次召回或搜索");
      return;
    }

    // 1. 取最近 MAX_ANCHORS 个锚点(防过拟合)
    const used = anchors.slice(-BijiHuangzhePlugin.REFINE_MAX_ANCHORS);
    const usedIds = new Set(used.map((a) => a.chunkId));
    const anchorTexts = used.map((a) => a.text);
    // 负反馈:lastResults 里没钉的(最多 5 个),作为"不想要这些方向"的信号
    const rejectedTexts = this.lastResults
      .filter((r) => !usedIds.has(r.chunkId))
      .slice(0, 5)
      .map((r) => r.text);

    // 2. 调 LLM 重写 query
    this.view?.setRefineThinking(true);
    // 锁旧卡片:模糊 + 淡出 + 失去交互,中央浮"AI · 召回中"指示器。
    // 这是"消失再绽开"的关键 —— 让用户在 refine 期间不被旧卡片错配信息污染。
    this.view?.setRefineInProgress(true);
    this.view?.setStatus(`AI 在重写 query(${used.length} 锚点 + ${rejectedTexts.length} 负反馈)…`);
    let verdict: RefineVerdict;
    try {
      verdict = await this.llmRefiner.refine({
        query,
        anchors: anchorTexts,
        rejected: rejectedTexts.length ? rejectedTexts : undefined,
      });
    } catch (e) {
      console.error("[拾荒者] LLM 改写失败:", e);
      new Notice("LLM 改写失败:" + (e as Error).message, 4000);
      this.view?.setRefineThinking(false);
      this.view?.setRefineInProgress(false); // 失败也要解锁旧卡片
      this.view?.setStatus("AI 改写失败");
      this.errorCount++;
      this.refreshStatusBar();
      return;
    }
    this.view?.setRefineThinking(false);

    if (!verdict.query) {
      new Notice("LLM 没给出有效的新 query — 检查锚点是否互相矛盾");
      this.view?.setRefineThought(verdict); // 让用户看到 conflict 字段
      this.view?.setRefineInProgress(false); // 没有新结果要展示,旧卡片恢复
      return;
    }

    // 3. 显示 thought / 新 query / boost·exclude 标签给用户看
    this.view?.setRefineThought(verdict);
    this.lastQuery = verdict.query; // ⬅ query 演化:下一轮 refine 用新 query 当参考
    this.view?.setStatus(`AI 改写完成,用新 query 召回中…`);

    // 4. 核心:混合向量召回 —— 防止 LLM 改写飘走
    //    锚点的 embedding 是用户标记出的"真实意图"的稳定锚,
    //    LLM 改写的 query 可能漂(尤其多轮迭代后),用锚点 mean 拉住它。
    //    实测:纯 LLM query 质量波动大,加 0.4 锚点向量后稳定很多。
    try {
      // 拿锚点的 embedding(都已经在缓存里)
      const anchorEmbs: number[][] = [];
      for (const a of used) {
        const e = this.indexer.embeddings.get(a.chunkId);
        if (e) anchorEmbs.push(e);
      }

      // embed LLM 改写的新 query
      const [newQueryEmb] = await this.embedClient.embed([verdict.query]);

      // 混合:60% 新 query 方向 + 40% 锚点向量稳定锚
      // (锚点为空时 fallback 到纯新 query)
      const mixEmb = anchorEmbs.length
        ? mixVec(newQueryEmb, meanVec(anchorEmbs), 0.6, 0.4)
        : newQueryEmb;

      const results = await this.matcher.match(
        verdict.query,
        undefined,
        true,         // skipAntiNoise
        true,         // skipMinQuery
        mixEmb,       // overrideEmb:跳过 matcher 自己 embed,用混合向量
        usedIds,      // 排掉锚点本身
      );
      // 5. boost / exclude 关键词后处理重排
      const reweighted = this.reweightByConcepts(results, verdict.boost, verdict.exclude);
      this.lastResults = reweighted;
      this.view?.showResults(reweighted, "search");
      this.view?.setStatus(`refine ${used.length} 锚点 · ${reweighted.length} 条新结果`);
      if (this.errorCount > 0) { this.errorCount = 0; this.refreshStatusBar(); }
    } catch (e) {
      console.error("[拾荒者] refine match 失败:", e);
      new Notice("搜索失败:" + (e as Error).message, 4000);
      this.view?.setRefineInProgress(false); // 解锁旧卡片
      this.view?.setStatus("搜索失败");
      this.errorCount++;
      this.refreshStatusBar();
    }
  }

  async openSource(notePath: string, chunkId: string, anchor?: string) {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) { new Notice("找不到原笔记"); return; }
    const chunks = this.indexer.chunksByPath.get(notePath) || [];
    const ch = chunks.find((c) => c.id === chunkId);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (!ch) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const v = leaf.view;
      if (!(v instanceof MarkdownView)) return;
      const editor = v.editor;
      const content = editor.getValue();

      // 1. 锚点:优先用卡片显示的那句话,否则退到 chunk 第一句
      let target = anchor?.trim() || "";
      if (!target) {
        const m = ch.text.match(/^[^。.!?！？\n]+[。.!?！？]?/);
        target = (m ? m[0] : ch.text.slice(0, 36)).trim();
      }

      // 2. 用 chunk 头部锚定 chunk 在当前文件里的实际起始位置,
      //    再在 chunk 内查 target 的相对偏移 —— 避免全文重复段落跳错。
      let foundOffset = -1;
      const chunkHead = ch.text.slice(0, Math.min(30, ch.text.length)).trim();
      const chunkOffsetInFile = chunkHead ? content.indexOf(chunkHead) : -1;
      if (chunkOffsetInFile >= 0) {
        const relInChunk = ch.text.indexOf(target);
        if (relInChunk >= 0) foundOffset = chunkOffsetInFile + relInChunk;
      }
      if (foundOffset < 0) foundOffset = content.indexOf(target); // 兜底:全文搜
      if (foundOffset < 0 && chunkOffsetInFile >= 0) foundOffset = chunkOffsetInFile;
      if (foundOffset < 0) foundOffset = ch.start;

      const startPos = editor.offsetToPos(foundOffset);
      const endPos = editor.offsetToPos(foundOffset + target.length);
      editor.setSelection(startPos, endPos);
      editor.scrollIntoView({ from: startPos, to: endPos }, true);
      editor.focus();
      this.flashLine(v.containerEl, startPos.line);
    }));
  }

  private flashLine(container: HTMLElement, line: number) {
    // Obsidian/CodeMirror 的行元素在 .cm-content > .cm-line 列表里
    // 我们 query 所有 .cm-line,按当前光标行偏移找
    setTimeout(() => {
      const lines = container.querySelectorAll(".cm-line");
      // CodeMirror 是按 visible 行排列,line 编号是文档行号。用 active 兜底
      const active = container.querySelector(".cm-active.cm-line") as HTMLElement | null;
      const target = active || (lines[line] as HTMLElement | undefined);
      if (!target) return;
      target.addClass("biji-flash");
      setTimeout(() => target.removeClass("biji-flash"), 1800);
    }, 50);
  }

  markUseful(chunkId: string, useful: boolean) {
    const fb = this.feedback[chunkId] || { useful: 0, useless: 0, lastAt: 0 };
    if (useful) fb.useful++;
    else fb.useless++;
    fb.lastAt = Date.now();
    this.feedback[chunkId] = fb;
    this.invalidatePrefVec(); // 让下次召回重算偏好向量
    this.persist();

    if (!useful && fb.useless >= 2) {
      new Notice(`✕ 已标为没用 · ${this.settings.dedupDays} 天内不再召回这条`, 2500);
    } else {
      new Notice(useful ? "✓ 标为有用 — 后续会更优先" : "✕ 标为没用 — 后续会降权", 2000);
    }
  }

  hideChunk(chunkId: string) {
    this.hidden[chunkId] = true;
    this.persist();

    // 带"撤销"按钮的 Notice,6 秒内可点回来 —— 防误触
    const frag = document.createDocumentFragment();
    const span = document.createElement("span");
    span.textContent = '已加入"别再提醒"';
    frag.appendChild(span);
    const undo = document.createElement("a");
    undo.textContent = "撤销";
    undo.style.marginLeft = "10px";
    undo.style.textDecoration = "underline";
    undo.style.cursor = "pointer";
    undo.style.color = "var(--text-accent)";
    frag.appendChild(undo);

    let n: Notice;
    undo.onclick = () => {
      delete this.hidden[chunkId];
      this.persist();
      n?.hide();
      new Notice("已撤销", 1500);
    };
    n = new Notice(frag, 6000);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_BIJI)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_BIJI, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async saveSettings() {
    this.embedClient = new EmbedClient(this.settings);
    this.llmJudge = new LlmJudge(this.settings);
    this.llmRefiner = new LlmRefiner(this.settings);
    this.rerankClient = new RerankClient(this.settings);
    this.rebuildDebouncer();
    await this.persist();
    this.refreshStatusBar();
  }

  // 标脏 + 节流写盘。所有 await this.persist() 改不动也能跑(立即返回 Promise),
  // 真正写盘 PERSIST_DEBOUNCE_MS 之后。需要立即写,调 flush()。
  async persist(): Promise<void> {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush().catch((e) => console.warn("[拾荒者] 写盘失败:", e));
    }, BijiHuangzhePlugin.PERSIST_DEBOUNCE_MS);
  }

  // 标记 embeddings 也需要重写(改了 embeddings.bin 的场景调用)。
  // 默认 persist 只重写 data.json,因为 embeddings.bin 30MB 不每次都重写。
  markEmbeddingsDirty(): void {
    this.embeddingsDirty = true;
    this.persist();
  }

  // 强制立即写盘 + 等待完成(onunload / 关键操作)
  async flush(): Promise<void> {
    if (this.persistInflight) await this.persistInflight;
    if (!this.dirty) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = false;
    this.persistInflight = this._persistNow();
    try {
      await this.persistInflight;
    } finally {
      this.persistInflight = null;
    }
  }

  private async _persistNow(): Promise<void> {
    const chunksByPath: Record<string, Chunk[]> = {};
    for (const [k, v] of this.indexer.chunksByPath) chunksByPath[k] = v;

    // data.json:轻量元数据 + chunks(不含 embeddings —— 那部分走 embeddings.bin)
    const writes: Promise<unknown>[] = [
      this.saveData({
        settings: this.settings,
        hidden: this.hidden,
        shown: this.shown,
        feedback: this.feedback,
        chunksByPath,
      }),
    ];

    // embeddings.bin:仅在 markEmbeddingsDirty 后重写,避免每次 persist 都写 30MB+
    if (this.embeddingsDirty) {
      this.embeddingsDirty = false;
      writes.push(
        this.embeddingStore.save(this.indexer.embeddings).catch((e) => {
          console.warn("[拾荒者] embeddings.bin 写盘失败:", e);
          this.embeddingsDirty = true; // 失败 → 下次 persist 再试
        })
      );
    }

    await Promise.all(writes);
  }
}

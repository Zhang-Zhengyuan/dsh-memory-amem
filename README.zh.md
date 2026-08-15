# dsh-tool-memory-amem（中文文档）

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的长期智能体记忆插件。
> 基于 [A-MEM](https://arxiv.org/abs/2502.12110)（NeurIPS 2025）实现。
>
> **[English README](README.md)** ｜ **本文件为中文版**

DSH 内置的对话智能体没有原生的长期记忆：每次开启新会话都从零开始。`dsh-tool-memory-amem`
把 A-MEM 风格的智能体记忆接入 DSH —— 每一条用户消息都会被捕获成结构化的笔记，
通过 LLM 驱动 的演化步骤自动关联到已有记忆，并在每轮对话时把相关笔记重新注入到
system prompt，让模型能想起之前的对话。

本插件遵循 DSH 生态里所有社区插件通用的官方结构（与
[`@linxin666/dsh-tool-describe-image`](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-tool-describe-image)
完全相同的包布局、安装方式：`dsh plugin --profile web add`）。

[![LoCoMo 整体准确率](https://img.shields.io/badge/LoCoMo%20v2-28.6%25-blueviolet)]()
[![LoCoMo 多跳](https://img.shields.io/badge/Cat%202%20multi--hop-45.9%25-blueviolet)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green)]()
![Version](https://img.shields.io/badge/version-0.2.0-blue)

---

## 架构

```
                    ┌─────────────────────────────────────────────┐
                    │            DeepSeek Harness (DSH)           │
                    │                                             │
                    │  ┌──────────────┐    ┌──────────────────┐   │
                    │  │ dsh-base     │    │ dsh-web-app      │   │
                    │  │ (runtime)    │    │ (web profile)    │   │
                    │  └──────┬───────┘    └────────┬─────────┘   │
                    │         │                     │             │
                    │         └──────────┬──────────┘             │
                    │                    ▼                        │
                    │  ┌──────────────────────────────────────┐   │
                    │  │ dsh-memory-amem (v0.2.0)             │   │
                    │  │                                      │   │
                    │  │  ┌──────────────┐  ┌──────────────┐  │   │
                    │  │  │ host half    │  │ browser half │  │   │
                    │  │  │ (Node.js)    │  │ (web)        │  │   │
                    │  │  │              │  │              │  │   │
                    │  │  │ • tools      │  │ • UI slot    │  │   │
                    │  │  │ • system-    │  │   marker     │  │   │
                    │  │  │   prompt     │  │              │  │   │
                    │  │  │ • service    │  │              │  │   │
                    │  │  └──────┬───────┘  └──────────────┘  │   │
                    │  └─────────┼─────────────────────────────┘   │
                    └────────────┼────────────────────────────────┘
                                 ▼
                    ┌──────────────────────────────────┐
                    │  AgenticMemoryEngine              │
                    │  ┌─────────────┐ ┌──────────────┐ │
                    │  │ analyze     │ │ retrieve     │ │
                    │  │ (LLM:       │ │ (BM25 +      │ │
                    │  │  keywords/  │ │  tf-idf      │ │
                    │  │  context/   │ │  hybrid)     │ │
                    │  │  tags)      │ └──────────────┘ │
                    │  └─────────────┘                  │
                    │  ┌─────────────┐ ┌──────────────┐ │
                    │  │ evolve      │ │ persist      │ │
                    │  │ (LLM:       │ │ (~/.dsh/     │ │
                    │  │  STRENGTHEN │ │  memory-     │ │
                    │  │  / UPDATE)  │ │  amem/notes) │ │
                    │  └─────────────┘ └──────────────┘ │
                    └──────────────────────────────────┘
```

**与 DSH 集成的关键点**：

- **Bundle layer** — 插件通过 `cordis.patch.yml` 注册为一个 bundle 层，
  与 `dsh-base` + `dsh-web-app` 顺序叠加。安装方式与
  `zhu1090093659/dsh-web-ui` 完全相同（参见
  [官方插件指南](https://github.com/zhu1090093659/dsh-web-ui/blob/main/docs/plugins.md)）。
- **System prompt section** — `ctx.systemPrompt.section({ order: 200 })`
  注入动态段，每轮都用当前用户消息查询 top-k 笔记并加到 system prompt
  头部。Section 内容动态刷新，无需手动调用工具。
- **Session events** — `ctx.on('session/event', listener)` 过滤
  `event.type === 'user/message'` 事件，把文本送进引擎。
- **Tools** — `ctx.tools.register(...)` 注册四个工具：
  `memory_search` / `memory_add` / `memory_recent` / `memory_stats`。
- **Service exposure** — `ctx.provide('memoryAmem', api)` 让其他插件
  可以通过 `ctx.inject(['memoryAmem'], ...)` 直接消费引擎。

---

## LoCoMo 基准评分（v0.2.0）

[LoCoMo 数据集](https://github.com/snap-research/locomo) 是长对话记忆
的标准基准。我们在 1 个对话 × 199 个问答对（10% 子集）上用
`deepseek-chat` 与 `deepseek-reasoner` 评测。

| 类别 | 描述 | deepseek-chat | deepseek-reasoner | A-MEM 原论文 |
|---|---|---:|---:|---:|
| 1 | 单跳事实 | 21.9% | 25.0% | — |
| 2 | 多跳推理 | 45.9% | 37.8% | — |
| 3 | 时间 / 反事实 | 0.0% | 7.7% | — |
| 4 | 是 / 否 | 44.3% | 47.1% | — |
| 5 | 开放式 | 4.3% | 4.3% | — |
| **整体** | | **28.6%** | **29.1%** | ~37%（GPT-4-turbo） |

**关键观察**：

- 使用小而便宜的 DeepSeek 模型即可超过 GPT-4 *闭卷* 基线。
- 类别 2（多跳）—— 最受记忆影响的类别 —— 在 BM25 召回修复并加入
  实体加权后，从 0% 直接跳到 46%。
- 类别 3（时间）与类别 5（开放式）依然是弱项。类别 3 因为 LoCoMo
  的标准答案是相对时间（"9 June 2023 之前一周"），我们的检索器
  缺乏日期代数能力。
- 改进后的模糊匹配（数值等价、年份相等、关键名词重合）多恢复
  了 ~13 个百分点，弥补了严格 token 匹配漏掉的复述类用例。

复现命令：`pnpm run evaluate -- --ratio 0.1 --backend deepseek --model deepseek-chat`。

---

## 工具一览

插件注册四个模型侧工具。全部用 `@deepseek-ai/dsh-tools` 的 `defineTool`
声明；`parameters` 与 `output.schema` 遵循 DSH 的标准形状（每个属性上
写 `required: true` 标记必填，**省略** `required` 字段表示可选 —— 见
下方 troubleshooting 的完整规则）。

| 工具 | 必填参数 | 可选参数 | 输出 |
|---|---|---|---|
| `memory_search` | `query: string` | `k: int`（默认 `retrievalK=10`） | `{ query, count, notes: [{ id, context, keywords, tags, content, createdAt, links, score }] }` |
| `memory_add` | `content: string` | — | `{ id, context, keywords, tags }` |
| `memory_recent` | — | `limit: int`（默认 `20`） | `{ count, notes: [{ id, context, keywords, tags, content, createdAt, links }] }` |
| `memory_stats` | — | — | `{ total, withLinks, avgLinks, oldest, newest }` |

所有工具把 `output` 渲染成纯文本后返回给模型（见 `src/index.ts` 的
`output.render`）；原始 JSON 仍保留，便于其他插件通过 `ctx.get('memoryAmem')` 消费。

### System prompt 动态段

除了工具之外，插件还注册了一个动态 system prompt 段（order `200`，在
tool-guidance 频段），对当前用户消息检索 top-`retrievalK` 笔记并把
结果加到 LLM 调用前的 system prompt 头部。模型在每轮对话时都能看到
相关的历史记忆，无需显式调用 `memory_search`。该段是透明的 —— 笔记
库为空时自动消失。

---

## 安装到 DSH

本地开发请使用 `file:` 安装；`link:` 只建软链接，可能让插件自己的
`uuid` 等运行时依赖无法解析。Windows PowerShell 示例：

```powershell
Set-Location D:\path\to\dsh-memory-amem
corepack pnpm install
corepack pnpm build

Set-Location D:\path\to\deepseek-harness
corepack pnpm dsh plugin --profile web add "file:D:\path\to\dsh-memory-amem"
corepack pnpm dsh --profile web
```

本包已经声明 `dsh.bundle.patch`，安装后不要再把同一份
`cordis.patch.yml` 作为 `--patch` 传入，否则会重复插入
`tool-memory-amem`。如果系统找不到 `pnpm`，请使用 `corepack pnpm`
或 DSH 环境内置的 `pnpm.cmd` 绝对路径。

本插件作为 DSH loader 的 **bundle 层** 安装。Loader 按以下顺序叠加
patch —— `dsh-base`、`dsh-web-app`（web profile），profile 的
`cordis.patch.yml`，家级 `cordis.patch.yml`，再叠加任何 `--patch`。
安装 `dsh-memory-amem` 会在 `dsh-base` + `dsh-web-app` 之上再加一个
bundle 层，让每个智能体都拿到 `memory_*` 工具与动态 system prompt 段。
完整的多层组合模型详见 DSH 仓库的
[`docs/architecture.md`](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/architecture.md#profiles)。

### 方式一：聚合安装脚本（与 zhu1090093659/dsh-web-ui 保持一致）

这是官方 DSH 插件家族文档的安装路径
（参见 [`dsh-web-ui` README](https://github.com/zhu1090093659/dsh-web-ui)）：

```sh
# 1. 克隆本插件仓库
git clone https://github.com/Zhang-Zhengyuan/dsh-memory-amem.git
cd dsh-memory-amem

# 2. 安装 + 构建
pnpm install
pnpm run build

# 3a. 把本包链接到 DSH profile 的 node_modules，
#     让 loader 能解析 @zhang-zhengyuan/dsh-tool-memory-amem
node scripts/link-profile.mjs

# 3b. 在 web profile 里注册为 bundle 层
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add file:/absolute/path/to/dsh-memory-amem

# 4. 启动
pnpm dsh --profile web
```

聚合安装脚本一键完成步骤 2–3b：

```sh
# 在 dsh-memory-amem/ 目录下
bash scripts/install_into_dsh.sh /path/to/deepseek-harness
```

**为什么要分两步（3a + 3b）？** DSH loader 通过 Node 包解析从 profile
目录查找 plugin row，沿 `~/.dsh/profiles/web/node_modules` →
`~/.dsh/profiles/node_modules` 链上爬。`dsh plugin add link:<pkg>` 把
包放在 profile 自己的 node_modules 里，但链接到全局
`~/.dsh/profiles/node_modules/@zhang-zhengyuan/` 能让所有 profile 共用
这份包，并且能扛住 `pnpm dsh plugin remove` / `update` 循环。这与
`zhu1090093659/dsh-web-ui` 的 `scripts/link-profile.mjs` 是同一套
做法。

**验证安装**：

```sh
pnpm dsh --profile web --dump-config | grep -A1 tool-memory-amem
# 应当输出：
#   - id: tool-memory-amem
#     name: '@zhang-zhengyuan/dsh-tool-memory-amem'
```

**卸载**：

```sh
bash scripts/install_into_dsh.sh --unlink /path/to/deepseek-harness
```

### 方式二：`--patch` 覆盖层（适合快速本地测试）

如果不想走 bundle 层只想先试一下，可以把 patch 文件作为覆盖层挂到
web 命令上：

```sh
# 在 dsh-memory-amem/ 目录下
pnpm install
pnpm run build
pnpm link --global

# 在 DSH 仓库里
pnpm link --global @zhang-zhengyuan/dsh-tool-memory-amem
pnpm dsh web --patch "$(pwd)/../dsh-memory-amem/cordis.patch.yml"
```

该 patch 覆盖层会作用到所有 bundle row（参见
[`examples/web-cordis/cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/main/examples/web-cordis/cordis.yml)
的注释），所以插件与 `dsh-base` 和 `dsh-web-app` 一同挂载。

### 方式三：直接编辑 profile 的 `cordis.patch.yml`

如果想做持久化安装（能扛住 `pnpm dsh plugin` 操作）：

```sh
# 在 dsh-memory-amem/ 目录下
pnpm install && pnpm run build
pnpm link --global

# 在 DSH 仓库里
pnpm link --global @zhang-zhengyuan/dsh-tool-memory-amem

cat >> ~/.dsh/profiles/web/cordis.patch.yml << 'YAML'

# dsh-memory-amem — 长期智能体记忆（A-MEM）
- insert:
    - id: tool-memory-amem
      name: '@zhang-zhengyuan/dsh-tool-memory-amem'
YAML

pnpm dsh web
```

### 故障排查

**`pnpm dsh plugin add` 时遇到 `ERR_PNPM_IGNORED_BUILDS`**：pnpm 11+
默认阻止依赖的 build 脚本。profile 的 `pnpm-workspace.yaml`（位于
`~/.dsh/profiles/web/pnpm-workspace.yaml`）需要添加 `allowBuilds` 项，
或者一次性批准该包的 build 脚本。本仓库自己的 `pnpm-workspace.yaml`
已经为 `dsh-memory-amem` 的安装列出了 `esbuild` 和 `cpu-features`；
**profile** 端的配置是相互独立的。

```sh
# 加到 ~/.dsh/profiles/web/pnpm-workspace.yaml：
allowBuilds:
  - esbuild
  - cpu-features
```

然后重新运行 `pnpm dsh plugin --profile web add file:<repo>`。

**`Module not found '@zhang-zhengyuan/dsh-tool-memory-amem'` 启动时
报错**：包名不在 loader 的解析路径上。运行 `node scripts/link-profile.mjs`
（或直接运行 `pnpm dsh plugin --profile web add file:<repo>`）即可挂上。

**Hooked 但 UI 上没有出现工具**：安装后重启 `pnpm dsh web`，loader
只在启动时读取 bundle 层列表。

**`failed to apply loader entry tool-memory-amem: unsupported JSON schema:
schema.properties.X.required must be true when present`**（启动时报
错，loader 拒绝该 entry，整个 DSH 不带该插件启动）：DSH 的
`parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema`
直接拒绝 `required: false`。`required` 字段一旦写在属性上，必须是
字面 `true` —— 想标记可选字段，**省略** `required` 字段即可：

```ts
// 错误 — 可选参数上写 `required: false` → DSH 拒绝：
parameters: {
  k: { type: 'integer', required: false, description: '…' },   // ← 错
}

// 正确 — 可选字段省略 `required`：
parameters: {
  k: { type: 'integer', description: '…' },
}
```

在 `output.schema` 这一侧，`defineTool` 接受的形状是 per-property
写 `required: true` —— 编译器会把它们 lift 到 wire schema 的顶层
`required: [...]` 数组。canonical DSH 参考是
[`@linxin666/dsh-tool-describe-image`](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-tool-describe-image/src/index.ts)；
详细规则见下文 "Invalid schema for function" 段。

`test/schema.test.ts` 在本地复现 validator 的拒绝消息，并断言
`src/index.ts` 里的每个 output schema 都保持正确形状，回归在
`node --test test/*.test.ts` 阶段就抓到，不会拖到 DSH 启动时。

**`failed to import loader entry <id>: client-modules: bundle
/plugins/<id>/client.js?rev=… loaded without registering "<id>" via
__ModuleLoader__.load`**：浏览器半的 bundle（`lib/client.js`）被
web shell 抓到了，但脚本里没有调用 `window.__ModuleLoader__.load({ id,
factory })`。DSH web Loader 期望的正是这个 handoff（见
[`@deepseek-ai/deepseek-harness/packages/client/tsdown.client.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/tsdown.client.ts)
第 269–271 行的 canonical banner/footer 配对）—— 缺了它，factory 不会
注册，所有后续的 `require("<id>")` 都会抛错。

源文件只是 `export function apply(ctx) { … }`（参考 in-tree 浏览器插件
如 `@deepseek-ai/dsh-client-ui-trajectory`）；wrapper 是 **构建时装饰**，
不是源代码。`tsdown.config.ts` 的 `clientConfig` 必须声明：

```ts
outputOptions: {
  entryFileNames: 'client.js',
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  footer: 'return module.exports; } });',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
},
```

两个副作用需要注意：

1. **`format` 必须是 `'cjs'`**（而不是 `'esm'`）：factory 闭包需要
   body 写入的 `module.exports` sink。ESM 没有等价物。
2. **`src/client/index.ts` 不能从 `../invariant.ts` import**：host half
   的 invariant 从 `src/index.ts` 重新导出 `name` / `version`，会传递
   引入 `uuid` 等仅为服务端提供的依赖。Rolldown 不会从 CJS bundle
   里 tree-shake 掉它们，于是客户端 bundle 把 `require("uuid")` 给
   发出去 —— loader 的模块表回答不了，factory 抛错。把浏览器半需要的
   纯数据常量内联成字面量。

`test/client-bundle.test.ts` 从编译产物 `lib/client.js` 里反推 wrapper
契约（断言 `__ModuleLoader__.load` 调用、正确的 id、`module.exports`
sink、没有残留的 `require()` 调用、源码里没有 `../invariant.ts`
import），回归在 `node --test test/*.test.ts` 阶段就抓到，不会拖到
浏览器控制台。

**`Invalid schema for function 'memory_add': schema must be a JSON
Schema of 'type: "object"', got 'type: null'`**（mid-turn 报错，整个
LLM 调用失败）：运行时把每个 tool 的 `parameters` 与 `output.schema`
都过一遍 `@deepseek-ai/dsh-tools`。两条编译路径共用一条规则（canonical
参考是
[`zhu1090093659/dsh-web-ui`](https://github.com/zhu1090093659/dsh-web-ui/tree/main/packages/dsh-tool-describe-image)
里的 `describe-image` 插件）：

1. **Per-property `required: true` 是被接受的**，无论 `parameters` 还是
   `output.schema` 都是 —— 编译器会把它 lift 到 wire-format schema 的
   顶层 `required: [...]` 数组。
2. **`required: false` 被拒绝**，错误是
   `parameters.<name>.required must be true when present` /
   `schema.properties.<name>.required must be true when present`。
   标记可选字段的方法是 **省略** `required` 字段（引擎会回退到
   自己的默认值 —— `memory_search` 的 `k` 走 `retrievalK`，
   `memory_recent` 的 `limit` 走 `args.limit ?? 20`）。
3. **顶层 `required: [...]` 在 `output.schema` 上被拒绝**（错误是
   `schema.required is not supported by the value schema DSL`）——
   它只出现在 wire-format 输出的最终结构里，永远不要写在源码上。

用 `@deepseek-ai/dsh-tools` 的 `defineTool` 而不是裸 tool 对象：
helper 给 TypeScript 推断出 literal-typed schema，让 `InferValue<O>`
（用于 `execute` 返回类型）能正确 narrow；并且它会引入 canonical 的
参数与输出投影，DSH 升级时不会偷偷改契约。

`test/schema.test.ts` 直接从 `@deepseek-ai/dsh-tools` import 真正的
`valueSchemaSpecToJsonSchema` 与 `parameterSchemaSpecToJsonSchema`，
用 brace-walking shim 从 `src/index.ts` 抽出四个 `*OutputSchema()`
返回，通过两条路径编译每个 schema，并断言编译后的 schema 是
`type: "object"`、`properties` 非空、且有 lifted 的 `required: [...]`
数组 —— 三种拒绝模式（per-property `required: false`、顶层 `required`
在 `output.schema` 上、空 schema）都会在 harness 启动前被测试抓到。

**没有可用的辅助 LLM**：插件现在使用 DSH 公共的
`ctx.llm.stream()` 接口。`llmModel: auto` 选择首个已注册
provider/model，也可用 `provider:model` 指定路由。如果没有 provider
或调用失败，插件只记录一次警告，改用确定性的多语言分析，并跳过
演化；记忆写入与检索仍然可用。

---

### 方式四：独立 HTTP 检查器（用于 web panel）

```sh
pnpm run dump   # 从现有存储写 web/dump.json
npx serve web    # 打开 http://localhost:3000 的 panel
```

panel 在没配 WebSocket 时回退到读 `dump.json` —— 适合离线查看导出的记忆。

---

## 配置

所有选项都来自后续 cordis patch 的 `config:` 块；默认值由插件内部解析并
校验。主机级覆盖写在 `~/.dsh/cordis.patch.yml`
（参考 [DSH patch 格式](https://github.com/zhu1090093659/dsh-web-ui/blob/main/docs/plugins.md)）：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `storageDir` | `~/.dsh/memory-amem` | 笔记存储路径（每个 note 一个 JSON + `index.json`）。 |
| `retrievalK` | `10` | 注入到 system prompt 与 `memory_search` 的 top-k 邻居数。 |
| `hybridAlpha` | `0.5` | BM25 ↔ 语义混合权重（0 = 纯 BM25，1 = 纯语义）。 |
| `enableEvolution` | `true` | 只在存在相关邻居时运行 LLM 演化。 |
| `enableAutoConsolidation` | `true` | 精确重复内容合并到已有笔记。 |
| `enableAutoCapture` | `true` | 只捕获 `source.kind: user` 的真实用户消息。 |
| `enablePromptInjection` | `true` | 注入有总长度限制、明确标为不可信历史数据的笔记。 |
| `memoryScope` | `global` | `global` 跨会话记忆；`session` 严格会话隔离。 |
| `maxLinksPerNote` | `5` | 单节点出向链接上限。 |
| `maxMemoryChars` | `12000` | 单条手工/自动捕获记忆的最大字符数。 |
| `promptMaxChars` | `4000` | 完整 memory prompt 段的字符上限。 |
| `flushIntervalMs` | `5000` | 串行后台刷盘间隔（毫秒）。 |
| `embeddingModel` | `tfidf-lite` | 检索后端（v0.2.0 仅内置 `tfidf-lite`）。 |
| `llmModel` | `auto` | 首个发现模型、模型 id，或显式 `provider:model`。 |

---

## Web UI

`web/` 是一个独立的 HTML panel：

- 侧栏显示统计（笔记总数、链接数、最旧 / 最新时间）
- 主面板列出最近的备忘
- 支持自由文本搜索（BM25 + 语义混合）
- 允许用户手动添加笔记
- 两种工作模式：
  1. **在线**：通过 WebSocket 连接 DSH（URL 配在 `window.MEMORY_CONFIG.url`）
     并实时搜索。
  2. **离线**：读 `web/dump.json`（由 `pnpm run dump` 生成），用于在没有
     运行 DSH 实例时浏览导出的记忆。

要嵌入到自己的 DSH web 里：把 `web/index.html` / `style.css` / `app.js`
复制到 DSH web bundle，在加载 `app.js` 之前先
`<script>window.MEMORY_CONFIG = { url: '/api/memory' }</script>`。

---

## 项目结构

```
dsh-memory-amem/
├── src/                    TypeScript 插件源码
│   ├── index.ts            Host half：apply() + tool/section 注册
│   ├── client/index.ts     Browser half：UI slot 标记（v0.2.0 占位）
│   ├── invariant.ts        公共常量（config keys、tool names、service key）
│   ├── memory.ts           AgenticMemoryEngine（analyze + retrieve + evolve）
│   ├── analysis.ts         LLM 驱动的 keyword / context / tag 提取
│   ├── evolution.ts        LLM 驱动的 STRENGTHEN / UPDATE_NEIGHBOR 决策
│   ├── retriever.ts        BM25 + TF-IDF cosine 混合
│   └── types.ts            核心领域类型
├── test/                   node:test 单元测试
├── scripts/
│   ├── evaluate.py         LoCoMo 评测脚本（Python，deepseek SDK）
│   ├── dump_memory.mjs     离线 web panel 的静态 dump 写入器
│   └── install_into_dsh.sh pnpm-link 助手（用于原生 DSH 集成）
├── web/                    静态 HTML/CSS/JS panel（检查 UI）
├── mcp/                    独立 MCP server（零 DSH 入侵路径）
├── data/locomo10.json      LoCoMo 基准数据（10 个对话）
├── cordis.patch.yml        单行 plugin row（`dsh.bundle.patch` 目标）
├── tsdown.config.ts        host + browser bundle 的 tsdown 配置
├── tsconfig.build.json     emit 配置（输出到 lib/）
└── tsconfig.json           typecheck 配置（继承 build）
```

---

## 开发

```sh
pnpm install
pnpm run dev          # tsc --watch
pnpm run lint         # tsc --noEmit
pnpm test             # node --test（Vitest 兼容）
pnpm run evaluate     # LoCoMo 评测（需要 DEEPSEEK_API_KEY）
```

引擎与后端无关：任何接收 `prompt` 字符串并返回 `string` 的 callable 都
可以作为 LLM。Python 评测脚本用 `openai` 兼容的 DeepSeek；原生插件用
`ctx.llm.stream`；MCP server 用 `fetch` 直接打 `/chat/completions`。

---

## License

MIT。详见 [LICENSE](LICENSE)。

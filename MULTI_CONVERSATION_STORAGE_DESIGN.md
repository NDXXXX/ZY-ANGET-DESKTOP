# DDClaw Desktop 多对话与 SQLite 存储设计

> 状态：多对话 MVP 已实施  
> 日期：2026-09-17  
> 适用范围：`apps/desktop` 与其使用的 Pi coding-agent 会话接口

当前实现已完成 SQLite 真源、旧 JSONL 幂等导入、真实会话列表、新建与切换、重启恢复、运行状态、置顶/重命名/归档/删除以及 Agent 内存会话恢复。第一阶段复用现有 `prompt` RPC，由 Main 为转发事件附加 `conversationId` 和 `runId`；独立 `run_prompt`、搜索界面、分页和并行 Agent 仍属于后续阶段。

## 1. 决策摘要

DDClaw Desktop 采用类似 OpenClaw 的会话管理方式：Electron 主进程是桌面会话的唯一管理者，Renderer 只查询和展示数据，SQLite 是桌面对话的唯一持久化真源。

本方案确定以下原则：

- SQLite 保存会话元数据、完整 transcript、分支关系、运行状态和全文搜索索引。
- Electron Main 中新增 `ConversationService`，统一处理新建、列表、打开、发送、停止、重命名、置顶、归档和删除。
- Renderer 不直接读取 SQLite，也不把 React state 或 `localStorage` 当作对话数据源。
- Agent 负责模型推理、上下文处理和工具执行，不直接决定桌面会话列表。
- 现有 JSONL 会话只做一次性导入，导入完成后不再和 SQLite 双写。
- 第一阶段只允许一个 Agent 任务运行；多个对话可以保存和切换，但不同时生成。
- 认证、模型配置和项目文件不迁入会话数据库，继续沿用现有存储位置。

## 2. 背景与问题

当前 Desktop 存在两套彼此割裂的状态：

```text
Renderer React state
  └── 当前窗口显示的消息、附件、项目

Pi SessionManager
  └── ~/.pi/agent/sessions/**/<timestamp>_<sessionId>.jsonl
```

当前行为造成以下问题：

1. 点击“新聊天”只让 Agent 创建新 session，并清空 Renderer 消息。
2. 左侧栏没有真实会话集合，始终只显示“当前会话”。
3. 关闭窗口后，JSONL 仍然存在，但 Renderer 不会恢复历史消息。
4. 当前项目、当前会话和会话标题没有统一持久化。
5. 会话列表需要扫描多个目录和 JSONL 文件，不适合后续搜索、置顶、归档和分页。
6. 流式事件没有携带桌面 `conversationId`，切换会话后容易把事件写到错误界面。

问题不在于 JSONL 不能保存消息，而在于 Desktop 缺少统一、可查询、可恢复的会话管理层。

## 3. 目标

### 3.1 必须实现

- 左侧显示真实的多对话列表。
- 点击“新聊天”后立即创建并显示一个空对话。
- 每个对话拥有稳定 ID、标题、项目归属和更新时间。
- 切换对话时恢复完整消息，不丢失上下文。
- 关闭并重新打开应用后恢复上次会话。
- 支持重命名、置顶、归档和删除。
- 支持自由对话和项目对话隔离。
- Agent 或应用异常退出后能够识别并恢复中断状态。
- 可以从现有 Pi JSONL 导入历史会话。

### 3.2 后续能力

- 会话全文搜索。
- 从指定消息创建分支。
- 多个会话同时后台运行。
- 跨设备同步和云端备份。
- 多 Agent 独立数据库。

### 3.3 不在本次范围

- 把 API Key、OAuth Token 存入会话数据库。
- 把项目源代码复制进数据库。
- 云同步和账号系统。
- 第一阶段支持多个 Agent 进程并行生成。
- 改变现有模型供应商协议。

## 4. 核心概念

### 4.1 Conversation

用户在侧边栏看到的一条对话。它拥有稳定的 `conversationId`，可以被重命名、置顶、归档和删除。

### 4.2 Transcript

Conversation 当前使用的一段模型上下文。执行“重置上下文”或创建分支时，可以在同一个 Conversation 下产生新的 Transcript。

### 4.3 Entry

Transcript 中按顺序追加的事件，包括：

- 用户消息
- Assistant 消息
- 工具调用和结果
- 模型变化
- 思考级别变化
- 压缩摘要
- 自定义扩展事件

Entry 使用 `parentEntryId` 表示分支关系，结构与现有 Pi `SessionEntry` 接近。

### 4.4 Run

一次从用户消息开始，到 Agent 完成、失败或被中止为止的执行过程。Run 用于区分普通历史消息和当前正在运行的任务。

### 4.5 Project

用户明确选择并信任的工作目录。一个 Project 可以拥有多个 Conversation；自由对话的 `projectId` 为 `NULL`。

## 5. 总体架构

```text
┌───────────────────────────────────────┐
│ Electron Renderer                     │
│ 会话列表、消息展示、输入和流式状态      │
└───────────────────┬───────────────────┘
                    │ 类型化 IPC
┌───────────────────▼───────────────────┐
│ Electron Main                         │
│ ConversationService                   │
│ - 会话生命周期                         │
│ - SQLite 事务                          │
│ - Agent 运行绑定                       │
│ - 崩溃恢复与迁移                       │
└──────────────┬───────────────┬────────┘
               │               │
┌──────────────▼───────┐ ┌─────▼──────────────┐
│ SQLite                │ │ AgentProcess        │
│ 元数据、Transcript、   │ │ 内存上下文、模型、   │
│ Entry、Run、FTS        │ │ 工具执行、流式事件    │
└──────────────────────┘ └────────────────────┘
```

### 5.1 数据所有权

| 数据 | 唯一所有者 | 说明 |
|---|---|---|
| 会话列表和标题 | ConversationService / SQLite | Renderer 只能查询和发出命令 |
| 完整 Transcript | ConversationService / SQLite | 不再以 JSONL 作为桌面真源 |
| 当前流式文本 | Renderer 临时状态 | 完成后由 Main 写入 SQLite |
| Agent 当前上下文 | AgentProcess 内存 | 切换会话时由 Main 从 SQLite 恢复 |
| 主题和侧边栏宽度 | Renderer `localStorage` | 仅界面偏好 |
| 模型认证和全局设置 | `~/.pi/agent/` 现有文件 | 不迁移到会话库 |
| 项目文件 | 用户选择的工作目录 | SQLite 只保存路径和元数据 |

## 6. 数据库位置与连接策略

数据库位置跟随现有 Pi Agent 配置目录：

```text
<getAgentDir()>/ddclaw.sqlite

默认：
~/.pi/agent/ddclaw.sqlite
```

这样可以避免 Electron `userData` 和 Pi Agent 配置目录形成两个无法关联的数据根目录。

SQLite 连接只存在于 Electron Main：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

实现优先使用当前 Node 22 已提供类型支持的 `node:sqlite`，避免 Electron 原生依赖重编译。如果打包环境验证不通过，再评估固定版本的 SQLite 驱动；切换驱动不得改变 Repository 接口和数据库结构。

## 7. 数据模型

所有时间统一保存为 Unix 毫秒。所有 ID 使用 UUID 字符串，由 Main 生成。

### 7.1 Schema migrations

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

每次启动先执行迁移。迁移必须在事务中完成，失败时不得部分更新版本号。

### 7.2 Projects

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);
```

规则：

- `path` 使用规范化绝对路径。
- 数据库记录项目路径不代表自动信任项目。
- 每次重新打开项目仍执行当前权限和存在性校验。

### 7.3 Conversations

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL UNIQUE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  current_transcript_id TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL CHECK (title_source IN ('default', 'auto', 'user')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'interrupted', 'error')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_at INTEGER,
  pinned_at INTEGER,
  archived_at INTEGER,
  last_read_at INTEGER
);

CREATE INDEX conversations_list_idx
  ON conversations(archived_at, pinned_at DESC, updated_at DESC);

CREATE INDEX conversations_project_idx
  ON conversations(project_id, archived_at, updated_at DESC);
```

`conversation_key` 采用稳定格式：

```text
desktop:<conversationId>
```

第一版不把项目路径编码到 key 中；项目关系由外键表达。

### 7.4 Transcripts

```sql
CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_transcript_id TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
  active_leaf_entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  reset_reason TEXT
);

CREATE INDEX transcripts_conversation_idx
  ON transcripts(conversation_id, created_at DESC);
```

Conversation 创建时立即同时创建第一个 Transcript，因此空对话也可以马上出现在侧边栏，不需要等待用户发送第一条消息。

### 7.5 Entries

```sql
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  parent_entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  entry_type TEXT NOT NULL,
  role TEXT,
  payload_json TEXT NOT NULL,
  searchable_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'interrupted', 'error')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(transcript_id, sequence)
);

CREATE INDEX entries_transcript_idx
  ON entries(transcript_id, sequence);

CREATE INDEX entries_parent_idx
  ON entries(parent_entry_id);
```

设计说明：

- `payload_json` 保存完整、可恢复的 Pi `SessionEntry` 数据。
- `searchable_text` 只保存用户和 Assistant 的纯文本投影。
- 工具结果、推理签名和图片不进入全文搜索。
- `sequence` 用于稳定排序，`parent_entry_id` 用于分支路径。
- Transcript 的 `active_leaf_entry_id` 指向当前有效分支末端。

### 7.6 Runs

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  user_entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'aborted', 'failed', 'interrupted')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_message TEXT
);

CREATE INDEX runs_conversation_idx
  ON runs(conversation_id, started_at DESC);
```

应用启动时把遗留的 `running` Run 改为 `interrupted`，同时更新对应 Conversation 状态。

### 7.7 Attachments

```sql
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  source_path TEXT,
  content_hash TEXT,
  stored_path TEXT,
  created_at INTEGER NOT NULL
);
```

附件规则：

- `source_path` 只用于展示来源，恢复历史时不能假定源文件仍然存在。
- 需要长期恢复的图片复制到 `<getAgentDir()>/assets/<sha256>`，数据库保存相对路径。
- 文本附件的实际发送内容保存在对应 Entry 的 `payload_json`，保证历史上下文可重放。
- 删除 Conversation 时，只删除没有被其他 Entry 引用的内容寻址附件。

### 7.8 App settings

```sql
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

第一阶段保存：

- `lastConversationId`
- `lastProjectId`
- `legacyJsonlImportVersion`

主题和侧边栏宽度仍保留在 `localStorage`，因为它们不影响会话一致性。

### 7.9 Legacy imports

```sql
CREATE TABLE legacy_imports (
  source_path TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  transcript_id TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('imported', 'skipped', 'failed')),
  error_message TEXT,
  imported_at INTEGER NOT NULL
);
```

该表只负责记录 JSONL 导入结果。`source_path + source_hash` 用于判断文件是否已经导入，`transcript_id` 用于追踪成功导入后的目标 Transcript。

### 7.10 全文搜索

```sql
CREATE VIRTUAL TABLE entry_search USING fts5(
  entry_id UNINDEXED,
  conversation_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

写入完整消息和 FTS 行必须发生在同一个事务中。删除 Entry 或 Conversation 时，同一事务删除对应索引行。

## 8. ConversationService

建议新增：

```text
apps/desktop/src/main/conversations/
├── conversation-service.ts
├── conversation-repository.ts
├── sqlite-conversation-repository.ts
├── migrations.ts
├── legacy-jsonl-importer.ts
└── types.ts
```

职责边界：

### ConversationService

- 校验业务规则。
- 管理当前打开的 Conversation。
- 把 Agent 事件绑定到正确的 `conversationId` 和 `runId`。
- 负责会话切换、运行状态和异常恢复。
- 不包含 SQL 字符串。

### ConversationRepository

- 定义数据库读写接口。
- 提供事务边界。
- 不依赖 Electron 或 React。

### SqliteConversationRepository

- 执行 SQL、迁移和 FTS 更新。
- 所有用户输入使用参数化语句。
- 不包含 Agent 业务逻辑。

### LegacyJsonlImporter

- 只读取现有 JSONL。
- 验证 session header 和 entry 结构。
- 幂等导入，不修改或删除原文件。
- 记录无法导入的文件及原因。

## 9. Agent 集成

### 9.1 最终状态

AgentProcess 作为执行引擎运行，SQLite 由 Main 独占写入。Agent 子进程不直接打开桌面数据库。

需要给 RPC 增加两个能力：

```text
load_session
  输入：sessionId、cwd、active entries、model、thinkingLevel
  作用：用 SQLite 中的 Transcript 重建 Agent 内存上下文

run_prompt
  输入：conversationId、runId、user entry、attachments
  作用：执行一次任务，所有事件携带 conversationId 和 runId
```

Agent 输出的最终事件至少包括：

```text
entry_committed
run_completed
run_failed
run_aborted
```

Main 收到 `entry_committed` 后写入 SQLite，再转发 Renderer。文本增量只用于即时显示，不要求每个 token 都写数据库。

### 9.2 第一阶段运行限制

- 一个 Desktop 窗口只启动一个 AgentProcess。
- Agent 正在运行时，不允许直接切换到另一个对话。
- 用户可以等待完成或先中止当前任务。
- 后续如需并行，改为 `Map<conversationId, AgentProcess>`，数据库模型无需改变。

### 9.3 与现有 RPC 的过渡

当前 RPC 已支持 `new_session` 和按 JSONL 路径执行 `switch_session`。迁移按以下顺序完成：

1. 先建立 Repository、SQLite schema 和 JSONL importer。
2. 增加 `load_session`，让 Agent 可以从传入 Entry 重建内存会话。
3. Desktop Agent 启动时使用内存 session，不再写新的桌面 JSONL。
4. 完成切换后，再移除 Desktop 对 `switch_session(sessionPath)` 的依赖。
5. CLI 仍可继续使用现有 JSONL SessionManager，除非另行决定统一迁移。

整个过渡期间只有一个消息真源：切换前是 JSONL，切换完成后是 SQLite；不长期双写完整消息。

## 10. IPC 设计

Renderer 只使用以下白名单接口：

```ts
interface ConversationSummary {
  id: string;
  projectId?: string;
  title: string;
  status: "idle" | "running" | "interrupted" | "error";
  createdAt: number;
  updatedAt: number;
  pinnedAt?: number;
  archivedAt?: number;
  lastMessagePreview?: string;
}

interface ConversationDetail extends ConversationSummary {
  transcriptId: string;
  entries: ConversationEntry[];
}
```

建议 Bridge：

```text
listConversations(options)
createConversation(options)
openConversation(conversationId)
renameConversation(conversationId, title)
setConversationPinned(conversationId, pinned)
archiveConversation(conversationId)
deleteConversation(conversationId)
sendConversationMessage(conversationId, input, attachments)
abortConversationRun(conversationId)
onConversationEvent(listener)
```

每个事件必须携带：

```text
conversationId
transcriptId
runId（属于运行事件时）
```

Renderer 收到非当前对话事件时，只更新侧边栏摘要，不得把文本追加到当前消息区。

## 11. 关键流程

### 11.1 应用启动

```text
打开数据库
  → 执行 schema migration
  → running 状态恢复为 interrupted
  → 必要时执行一次 JSONL 导入
  → 读取 lastConversationId
  → 返回会话列表和当前会话
  → 按需启动并加载 Agent
```

### 11.2 新建对话

一个事务完成：

1. 插入 Conversation，标题为“新对话”。
2. 插入第一个 Transcript。
3. 更新 `current_transcript_id`。
4. 更新 `lastConversationId`。
5. 提交后通知 Renderer。

新对话创建后立即出现在左侧，即使用户还没有发送消息。

### 11.3 发送消息

```text
验证当前 Conversation 可运行
  → 事务写入用户 Entry 和 Run(running)
  → 更新 Conversation 状态
  → 调用 Agent run_prompt
  → 转发流式增量
  → 持久化工具和 Assistant 最终 Entry
  → Run 标记 completed / failed / aborted
  → 更新标题、预览和 updated_at
```

用户消息必须先提交 SQLite，再调用模型。这样即使 Agent 启动失败，用户输入仍可恢复并重试。

### 11.4 自动标题

- 新对话标题默认为“新对话”。
- 第一条用户消息成功写入后，生成最多 30 个可见字符的本地标题。
- `title_source = 'user'` 时，后续消息不得覆盖用户手动标题。
- 第一阶段不额外调用模型生成标题。

### 11.5 切换对话

```text
确认当前没有运行任务
  → 保存 lastConversationId
  → 查询 ConversationDetail
  → Renderer 立即显示持久化消息
  → 在首次继续发送前 load_session
```

加载 Agent 可以延迟到用户发送下一条消息，避免浏览历史时频繁重建上下文。

### 11.6 归档与删除

- 归档只设置 `archived_at`，默认会话列表不再显示。
- 取消归档清空 `archived_at`。
- 删除必须二次确认，并级联删除 Transcript、Entry、Run 和 FTS 行。
- 正在运行的 Conversation 不允许归档或删除。
- 删除会话永远不删除项目目录及其中的文件。

## 12. JSONL 迁移

### 12.1 发现范围

扫描：

```text
~/.pi/agent/sessions/**/*.jsonl
```

读取 header 中的 `id`、`cwd` 和时间，按规范化 `cwd` 关联 Project。

### 12.2 幂等规则

- Transcript ID 优先使用原 JSONL session ID。
- 保存 legacy source path 和文件摘要，用于避免重复导入。
- 单个坏文件不阻止其他会话导入。
- 导入操作整体分批提交，应用不删除原始文件。
- 完成后写入 `legacyJsonlImportVersion`。

### 12.3 标题规则

优先级：

1. 原 session name。
2. 第一条用户消息的前 30 个可见字符。
3. 项目名加创建时间。
4. “历史对话”。

### 12.4 回滚

SQLite 迁移完成前，JSONL 保持不变。若新数据库无法打开，可以备份损坏数据库并重新从 JSONL 导入。完成 SQLite 切换后产生的新会话不会自动反向导出为 JSONL。

## 13. 一致性与异常恢复

### 13.1 事务边界

以下操作必须是单个事务：

- 创建 Conversation 和首个 Transcript。
- 写入用户消息并创建 Run。
- 完成 Assistant Entry、更新 Run 和 Conversation。
- 删除 Conversation 及其搜索索引。
- 导入一个完整 JSONL session。

### 13.2 崩溃恢复

- Main 启动时将所有遗留 `running` 状态改为 `interrupted`。
- 已提交的用户消息保留，可由用户手动重试。
- 未完成的流式 Assistant 草稿不进入正式上下文。
- 已完成的工具结果在产生 `entry_committed` 后立即保存。
- 数据库打不开时显示明确错误，不创建第二个空数据库覆盖原文件。

### 13.3 并发

- 第一阶段 Main 是唯一数据库写入者。
- Repository 对写操作串行化。
- 列表读取可以并发，但必须使用短查询和分页。
- 所有状态变更使用事务，不依赖 Renderer 当前状态进行判断。

## 14. 安全与隐私

- Renderer 保持 `contextIsolation: true`、`nodeIntegration: false` 和 `sandbox: true`。
- Renderer 不接收数据库路径，也不能执行任意 SQL。
- 项目路径和附件路径在 Main 中重新验证。
- SQL 使用参数化语句。
- API Key、OAuth Token 和环境变量不得写入 transcript。
- 工具输出进入数据库前执行现有敏感信息处理规则。
- 历史文本附件可能包含敏感内容，界面需要在删除会话时说明本地副本会被清理。
- 数据库文件权限遵循当前用户目录权限，不开放网络访问。

## 15. 性能要求

- 启动只读取最近一页会话摘要，不加载全部 Entry。
- 默认列表每页 50 条。
- 打开会话时按 Transcript 查询 Entry。
- 长对话后续支持按消息窗口分页，首屏最多加载最近 100 条可见消息。
- 搜索使用 FTS5，不扫描 `payload_json`。
- 流式 token 不逐 token 写库，只持久化最终 Entry。
- 所有列表查询必须有索引支持。

## 16. 测试计划

### Repository 单元测试

- 创建空 Conversation 后立即可列出。
- 多个 Conversation 按置顶和更新时间排序。
- Entry 顺序和 parent 关系正确。
- 删除 Conversation 级联删除关联数据和 FTS。
- 数据库重开后数据一致。

### 迁移测试

- 导入正常 JSONL。
- 重复导入不产生重复会话。
- 损坏 JSONL 不影响其他文件。
- session name、项目路径和分支关系正确转换。

### IPC 测试

- Renderer 无法访问未暴露的方法。
- 非法 Conversation ID 被拒绝。
- 非当前 Conversation 的事件不会进入当前消息区。

### 集成测试

```text
创建对话 A → 发送消息 → 创建对话 B → 发送消息
→ 切回 A → 上下文连续 → 关闭应用 → 重开
→ A、B 都存在并可继续
```

还需要覆盖：

- Agent 运行中崩溃。
- Main 在用户消息写入后、调用 Agent 前退出。
- 项目目录被移动或删除。
- 应用升级执行数据库迁移。

## 17. 实施顺序

### 阶段一：数据库基础

- 建立 Repository 接口和 SQLite schema。
- 完成迁移器、事务和 Repository 测试。
- 实现 JSONL 只读导入。

验收：可以从现有会话生成稳定、可分页的 Conversation 列表。

### 阶段二：会话 IPC 与侧边栏

- 新增 ConversationService。
- 暴露 list、create、open、rename、pin、archive、delete。
- 左侧栏接入真实会话数据。

验收：新建空对话立即出现，重启后列表仍存在。

### 阶段三：Agent SQLite 会话恢复

- 增加 `load_session` 和带标识的 `run_prompt`。
- Agent 使用内存 session 执行。
- Main 持久化最终 Entry 和 Run 状态。
- 停止 Desktop 新 JSONL 写入。

验收：A、B 两个会话反复切换后，模型上下文都正确。

### 阶段四：完整管理能力

- 置顶、归档、删除和全文搜索。
- 中断恢复和错误状态。
- 长列表和长 Transcript 分页。

验收：达到 Codex/OpenClaw 风格的日常多对话管理能力。

### 阶段五：可选并行

- 每个运行中的 Conversation 绑定独立 AgentProcess。
- 增加最大并发数和资源回收策略。
- 后台对话完成时更新未读状态。

该阶段不是多对话 MVP 的前置条件。

## 18. 完成标准

以下条件全部满足时，多对话存储改造完成：

- SQLite 是 Desktop 新会话的唯一消息真源。
- 新对话不发送消息也能立即显示。
- 会话列表、标题、置顶和归档在重启后保留。
- 切换会话后显示与 Agent 上下文一致。
- JSONL 历史可以幂等导入。
- Agent 崩溃不会破坏数据库或丢失已提交的用户消息。
- Renderer 不直接接触数据库、文件系统或任意 IPC。
- 全部新增 Repository、迁移和关键会话流程测试通过。

## 19. 参考架构

本设计借鉴 OpenClaw 的以下做法，但不照搬其多渠道和多 Agent 复杂度：

- Gateway 作为会话状态唯一管理者。
- 每个 Agent 使用独立 SQLite 会话库。
- 使用稳定会话 key 和实际 transcript ID 分离逻辑对话与上下文实例。
- 会话列表保存标题、预览、置顶、归档和运行状态。
- Transcript 与全文索引在同一事务中写入。

官方参考：

- [OpenClaw Session management](https://github.com/openclaw/openclaw/blob/main/docs/concepts/session.md)
- [OpenClaw session schema](https://docs.openclaw.ai/reference/session-management-compaction/schema)
- [OpenClaw multi-agent storage](https://github.com/openclaw/openclaw/blob/main/docs/concepts/multi-agent.md)
- [OpenClaw session search](https://docs.openclaw.ai/concepts/session-search)

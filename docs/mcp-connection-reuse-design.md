# MCP 连接复用设计文档

状态：已实现  
更新时间：2026-09-19  
适用范围：`packages/coding-agent/examples/extensions/mcp`

## 1. 背景与问题

桌面端切换对话时明显卡顿。定位后确认与界面渲染、转录数据量无关，而是每切换一次对话，就把所有 MCP 服务器子进程杀掉再重新启动一遍。

### 1.1 实测数据

用真实转录（从 `~/.pi/agent/ddclaw.sqlite` 导出 8 条 entry、10 849 字节）对着真实 CLI 进程计时，复刻桌面端的启动参数与 RPC 帧（JSONL over stdio，`load_session` + `get_state`），在同一进程内连续切换三次：

| 配置 | 进程启动 | 第 1 次切换 | 第 2 次切换 | 第 3 次切换 |
|---|---|---|---|---|
| 不带扩展 | 300 ms | 11 ms | 9 ms | 8 ms |
| 带 MCP 扩展（playwright + chrome-devtools） | 6 807 ms | 6 216 ms | 7 911 ms | 7 149 ms |

两轮独立复测结果一致。切换成本与转录大小无关（10 KB 的转录与空转录同量级），与已安装的 MCP 服务器数量和它们的启动代价成正比。

### 1.2 影响面

- **切换对话**：每次 6–8 秒，是用户感知到的主要卡顿。
- **切换项目 / 切换模型 / 自由对话与项目互切**：`runtimeKey` 变化导致整个 agent 进程重启，除了 300 ms 的进程启动，还要再付一次全部 MCP 服务器连接成本（上表第一列 6.8 秒）。

## 2. 根因

### 2.1 调用链

1. 切换对话 → `conversation-service.ts:193` 调 `agent.loadSession(cwd, sessionId, entries)`。
2. Agent 侧 `agent-session-runtime.ts:232` 的 `loadSession` 是**整套 runtime 重建**：先 `teardownCurrent("resume")`，再 `createRuntime(...)`。因此每次切换都会触发一次 `session_shutdown` 和一次 `session_start`。
3. 扩展 `index.ts:196` 的 `session_shutdown` 关闭所有 MCP 客户端并清空 `servers`、`registeredToolNames`，把 `initialized` 置回 `false`。
4. 扩展 `index.ts:163` 的 `session_start` 重新读配置，对每个服务器 `client.connect()`（`npx -y ...` 冷启动）并 `listTools()`，全部 `await` 完成后才返回。

结果是每切换一次对话，就重启一遍所有 MCP 服务器。7 秒基本就是两个 `npx` Node 服务的冷启动耗时。

### 2.2 关键事实（实测确认）

1. **扩展模块在同一个进程内是复用的**：用一个把模块级计数器写进日志的探针扩展，在同一个 RPC 进程内连续 `load_session` 三次，计数器输出 1 → 2 → 3 → 4，说明模块级状态跨会话存活。
2. **工厂函数每个会话都会重新执行**：同一个探针显示 `export default function` 每次会话都被调用一次，因此**声明在工厂内的变量（`servers`、`registeredToolNames`、`initialized`）每个会话都会丢**。要跨会话复用的状态必须提到模块级。
3. **一次会话重建中 `session_start` 可能触发多次**（实测同一 factory 实例打印了两次 `session_start`），因此复用逻辑必须幂等。
4. `session_shutdown` 在旧会话被替换时触发，并不代表进程即将退出——进程仍然活着并继续服务下一个会话。

## 3. 目标与非目标

### 3.1 目标

- 同一个 agent 进程内，配置未变化的 MCP 服务器**不重复连接**：第二次及以后的会话只重新注册工具，不做任何 I/O。
- 首次连接的成本与行为保持不变（工具必须在 system prompt 构建前就绪）。
- 切换对话的成本回到毫秒量级。
- 不泄漏子进程：进程退出时所有 MCP 子进程必须被终止。
- 配置变更（通过桌面端插件面板增删插件）仍然能够生效。

### 3.2 非目标

- 不修改 core 的 `loadSession` / runtime 重建逻辑（`packages/coding-agent/src/core/`）。即使不做本次改动，不带扩展的重建成本也只有 8–11 ms，说明重建本身不是瓶颈，无需为它引入 core 改动。
- 不修改 `apps/desktop`。
- 不引入懒连接（首次调用工具时才连接）。工具必须在首轮就出现在 system prompt 中，懒连接会改变用户可见行为。
- 不引入空闲回收 / TTL。
- 不改变 MCP 协议交互本身。

## 4. 设计

### 4.1 状态分层

把当前混在一起的两种状态拆开，各自放到正确的生命周期上：

| 状态 | 生命周期 | 存放位置 | 内容 |
|---|---|---|---|
| 连接（`ServerConnection`） | 进程级 | 模块级 `Map` | MCP 客户端、配置快照、工具清单、连接状态 |
| 注册（`registeredToolNames`） | 会话级 | 工厂实例内（维持现状） | 本会话已注册的工具名，用于去重 |

工具注册必须每个会话重做一次：runtime 重建后 `pi.registerTool` 的注册表是全新的，而 `client`、`tools` 可以复用。

### 4.2 数据结构

```ts
interface ServerConnection {
	name: string;
	/** 连接时使用的配置，用于判断是否需要重连。 */
	config: ServerConfig;
	client: McpClient;
	tools: McpTool[];
	connected: boolean;
	error?: string;
}

// 模块级：跨会话存活
const connections = new Map<string, ServerConnection>();
```

工厂内保留 `registeredToolNames`，`initialized` 的语义从「本进程已初始化」变为「本会话已处理过 session_start」，用于应对 2.2 中第 3 条的多触发。

### 4.3 `session_start`

对配置里的每个服务器按下表处理：

| 情况 | 行为 | 是否通知 |
|---|---|---|
| 无缓存 | 连接 + `listTools` + 注册工具 | 是 |
| 有缓存、配置相同、`connected` | 直接用缓存的 `tools` 注册工具 | **否** |
| 有缓存、配置不同 | 关闭旧连接 → 连接 + `listTools` + 注册 | 是 |
| 有缓存但 `connected === false`（上次失败或调用失败标脏） | 重连 + `listTools` + 注册 | 是 |

配置不同的判断用 `JSON.stringify(config)` 比较即可（配置对象很小，且来自同一个解析函数，键顺序稳定）。

另外，配置里已被删除的服务器：关闭其连接并从 `connections` 中移除，避免用户移除插件后子进程仍然常驻。

通知只在真正发生连接动作时发出，复用路径保持静默——目前每次切换都会重复弹出「Connected to MCP server ...」提示，复用后这类噪音也会消失。

### 4.4 `session_shutdown`

只做一件事：清空 `registeredToolNames`。不再关闭客户端、不再清空 `connections`、不再重置 `initialized`。

### 4.5 进程退出清理

注册一次性的退出钩子，同步终止所有子进程：

```ts
process.once("exit", () => {
	for (const connection of connections.values()) connection.client.kill("SIGTERM");
});
```

需要在 `mcp-client.ts` 上暴露一个同步的终止入口（现有的 `close()` 是异步的，在 `exit` 钩子里无法 `await`）。若 `McpClient` 已经能拿到子进程句柄，直接用即最小改动。

局限：`exit` 钩子在 `SIGKILL`、进程崩溃时不执行，会留下 `npx` 孤儿进程。这与现状相比不是新增风险（现状同样依赖父进程正常退出），缓解手段是子进程 stdin 收到 EOF 后自行退出；本次不为其增加额外机制，作为已知限制记录。

### 4.6 失败与重试

现有的 `callTool` 失败后重连一次的逻辑保持不变，但需要把结果写回连接状态：

- 重连成功 → `connected = true`，清空 `error`。
- 重连失败 → `connected = false`，记录 `error`。

这样下一次 `session_start` 会按 4.3 的分支自动重连，用户不需要重启应用。

### 4.7 配置变更的生效时机

桌面端插件面板保存配置后，运行中的 agent 进程不会立刻感知；新配置在**下一次会话重建**（切换对话、新建对话、重启应用）时按 4.3 的分支生效——配置不同的服务器会被关闭重连，新增的服务器会被连接，删除的会被关闭。

这与现有「插件变更在下次对话中生效」的产品说明一致，见 `mcp-plugin-center-design.md` §6.5。

## 5. 行为变化与风险

| 变化点 | 影响 | 缓解 |
|---|---|---|
| MCP 子进程存活期从「会话级」变为「进程级」 | 只要 agent 进程活着，子进程常驻（每个约几十 MB） | 这是省掉重启时间的原因，需明确接受 |
| `session_shutdown` 不再清理连接 | 语义变化，需要在代码注释中同步说明 | 更新 `index.ts` 文件头「Connections are established eagerly on `session_start` … and torn down on `session_shutdown`」这段描述 |
| 不再每次会话重复通知「已连接」 | 用户少看到重复提示 | 视为改善 |
| `SIGKILL` 场景下可能留下 orphans | 与现状同级 | 记录为已知限制 |
| CLI 路径（`/new`、`--resume`）同样复用连接 | 行为一致变化 | 属于同一机制的收益，无需单独处理 |

## 6. 验证方案

### 6.1 自动化测试

沿用仓库已有的扩展测试模式（直接 import 工厂函数 + 手写 `ExtensionAPI` 假对象，参见 `test/plan-mode-extension.test.ts`），配合已有的 stdio fixture 服务器 `test/fixtures/mcp-echo-server.mjs`（支持通过 `MCP_ECHO_PID_FILE` 输出自身 pid）：

1. 用同一个假 `pi` 调用工厂两次，模拟两次会话：
   - 断言两次注册的工具名集合一致（复用后工具仍然可用）。
   - 断言第二次会话没有产生新的子进程（pid 文件内容不变）。
2. 改变配置后再次调用工厂：断言 pid 变化（确实重连了）。
3. `session_shutdown` 之后：断言子进程仍然存活。
4. 配置里删除某个服务器后：断言对应子进程被终止。

### 6.2 端到端计时回归

在真实 CLI 进程上复现本次的测量方法（带扩展启动 → 连续 `load_session` 三次 → 记录每次耗时）：

- 第 1 次切换仍应是秒级（首次连接）。
- 第 2、3 次切换应降到 **50 ms 以内**（对比当前 6–8 秒）。

### 6.3 手工验证

桌面端切换对话，确认：切换即时完成；插件页面的连接状态正常；连续切换多次不产生新的 MCP 子进程（`pgrep -f "mcp@latest"` 数量稳定）。

## 7. 影响范围

- 主要改动：`examples/extensions/mcp/index.ts`（状态分层、两个生命周期钩子、退出钩子）。
- 可能的小改动：`examples/extensions/mcp/mcp-client.ts` 暴露同步终止入口。
- 注释：`index.ts` 文件头的生命周期说明。README 目前不描述生命周期，无需改动。
- 不改动：core、`apps/desktop`、`config.ts` 的配置格式与解析。

## 8. 验证结果（2026-09-19 实现后实测）

用 §1.1 的同一套测量方法复测（真实 CLI 进程、`load_session` + `get_state` 帧、同一进程内连续切换三次），配置仍是 `playwright` + `chrome-devtools` 两个 `npx` 服务器：

| 配置 | 进程启动 | 第 1 次切换 | 第 2 次切换 | 第 3 次切换 |
|---|---|---|---|---|
| 不带扩展 | 309 ms | 11 ms | 9 ms | 7 ms |
| 带扩展（修复前） | 6 807 ms | 6 216 ms | 7 911 ms | 7 149 ms |
| 带扩展（修复后，3 轮） | 9 757 / 7 387 / 6 909 ms | 16 / 13 / 15 ms | 12 / 11 / 11 ms | 12 / 11 / 11 ms |

- 切换成本 6–8 秒 → **11–16 ms**，达到 §6.2 的 50 ms 目标。
- 进程启动仍是 6.9–9.8 秒：首次连接的成本被保留，符合 §3.1。
- 自动化测试：`test/mcp-extension-reuse.test.ts` 4 项通过（复用不重启子进程、`session_shutdown` 后子进程存活、配置变化触发重连、配置删除关闭连接）；连同 `mcp-client.test.ts` 与 `apps/desktop/test` 共 42 项通过。
- 退出清理：真实进程收到 `SIGTERM`（桌面端 `AgentProcess.stop()` 的方式）后，`exit` 钩子成功终止 MCP 子进程（实测 pid 由存活变为不存在）。

## 9. 待确认问题

1. 实测到一次会话重建中 `session_start` 会触发两次，原因待查（不影响设计，但实现时必须保证幂等，并在真实进程中复核这一现象）。
2. 多个服务器目前是串行连接，首次连接成本是各服务器之和；若首连体验仍不可接受，可改为并行 `connect`（收益是 sum → max，风险是多个 `npx` 同时下载）。本设计不做，列为后续项。
3. 是否需要主动回收长期空闲的连接（TTL）。本设计不做。

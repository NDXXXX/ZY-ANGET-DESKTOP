# 桌面端发布就绪与 MCP 稳定性整改设计

状态：已实现（账号型插件凭据保护仍为后续启用前置条件）
更新时间：2026-09-21
适用范围：`apps/desktop`、`packages/coding-agent/examples/extensions/mcp`、Coding Agent RPC

## 1. 背景

当前桌面端已经具备对话、插件目录、MCP 配置和技能列表，但仍处于“仓库内开发运行可用”的阶段，尚未达到可稳定分发的条件。

本轮审查确认了以下问题：

1. 桌面构建只生成 `dist`，Agent CLI 和 MCP 扩展仍通过仓库相对路径查找。安装后的 `.app` 可能找不到运行资源。
2. Agent 和 stdio MCP 子进程只发送 `SIGTERM`，没有可靠等待退出；MCP 的强制终止判断使用了 `proc.killed`，该字段不代表进程已经退出。
3. 内置插件通过 `npx -y` 执行未锁定版本的软件；执行本地进程的插件并非全部要求用户确认。
4. 技能页自行扫描目录，结果可能与 Agent 实际加载的技能、冲突处理和诊断信息不一致。
5. 打开插件页会自动探测全部服务器，可能重复启动与 Agent 并行的 MCP 进程。
6. 多个 MCP 服务器首次连接时串行等待，启动时间是各服务器耗时之和。
7. “图像”“定时任务”“探索”等入口看起来可以操作，但目前没有行为。
8. 当前相关测试通过，但仓库静态检查仍因新增测试中的隐式 `any` 失败，暂不满足合并条件。

## 2. 假设与已选方案

### 2.1 假设

- 第一发布目标是 macOS；Windows 和 Linux 打包不在本设计范围内。
- 继续使用现有 Coding Agent RPC 和 MCP 扩展，不把 MCP 协议实现搬入 Electron 主进程。
- 保留 `~/.pi/agent/mcp-servers.json` 作为 MCP 配置事实来源，避免迁移用户已有配置。
- 本轮不实现图像、定时任务和探索功能，只让未开放入口不再误导用户。
- 本轮不建设在线插件市场、OAuth 服务或自动更新服务。

如果第一发布目标不是 macOS，签名、凭据存储和进程终止方案需要重新设计，不能直接照搬本方案。

### 2.2 关键取舍

#### 技能来源

有两个可行方案：

- 桌面端复用 `loadSkills()` 自己加载一次。
- Agent 通过 RPC 返回当前 runtime 已加载的技能。

选择第二种。它能保证桌面显示的就是 Agent 正在使用的结果，包括设置中的额外路径、包提供的技能、重名冲突和诊断信息。代价是技能页依赖 Agent 已启动；这与当前桌面应用本身的运行前提一致。

#### 插件运行状态

可以为 MCP 扩展新增实时状态通道，也可以停止自动探测，改为明确显示“已安装 / 未检测”，由用户手动测试单个插件。

本轮选择手动测试。新增跨进程状态协议会扩大改动面，而“未检测”比用另一个临时进程冒充 Agent 实际状态更准确。实时状态回传留到确有产品需求时再设计。

#### 打包方式

选择沿用现有 esbuild/Vite 产物，并用一个 Electron 打包器生成 macOS unpacked、DMG 和 ZIP。建议使用 `electron-builder`，因为它可以直接消费现有 `dist`，不要求迁移到新的工程脚手架。新增依赖必须固定精确版本。

## 3. 目标与非目标

### 3.1 目标

- 安装后的应用能够定位并启动 Agent CLI 与 MCP 扩展，不依赖源码仓库或当前工作目录。
- 正常退出、切换运行配置和连接失败时不遗留 Agent/MCP 子进程。
- 内置插件执行内容可复现；任何本地程序首次启用前都必须获得用户确认。
- 技能页与 Agent 实际加载结果一致，并能展示被忽略技能的原因。
- 打开插件页不自动启动所有 MCP；首次启动多个 MCP 时不再串行累加等待时间。
- 未实现入口具有明确的禁用状态。
- 静态检查、定向测试和打包后冒烟测试全部通过。

### 3.2 非目标

- 不修改对话数据模型。
- 不支持 MCP 热重载；配置仍在新建或切换会话时生效。
- 不增加插件评分、在线搜索、账号授权或更新机制。
- 不为拆文件而重构完整 `App.tsx`；只在职责发生变化的代码边界做必要拆分。
- 不在本轮恢复 macOS 硬件加速。当前禁用是针对黑屏问题的稳定性措施，是否恢复需要单独的 GPU 兼容性数据。

## 4. 总体结构

```text
打包阶段
  Coding Agent build ──┐
  Desktop build ───────┼─> macOS .app/resources/runtime
  MCP extension files ─┘

运行阶段
  Renderer
    ├─ 插件配置操作 ──IPC──> Electron Main ──> mcp-servers.json
    ├─ 单插件手动检测 ─IPC──> 临时 Probe ──退出后清理
    └─ 技能列表 ──────IPC──> Agent RPC get_skills
                                      │
                                      └─ ResourceLoader（唯一事实来源）

  Electron Main ──> Agent 子进程 ──> MCP 扩展 ──> MCP 子进程/HTTP
```

## 5. 分阶段设计

### Phase 0：恢复合并门槛

只处理已经确认的检查错误：

1. 给 `mcp-extension-reuse.test.ts` 的 `runHooks(name)` 参数补上现有 `HookName` 类型。
2. 移除两份现有设计文档中被 `git diff --check` 报告的尾随空格。
3. 不借此修改测试结构或格式化无关代码。

验收：

- `npm run check` 退出码为 0。
- `git diff --cached --check` 无输出。
- MCP 与桌面端相关定向测试保持通过。

### Phase 1：可靠终止 Agent 与 MCP 进程

#### 5.1 正常关闭算法

`AgentProcess.stop()` 和 `StdioTransport.close()` 使用相同的行为，但暂不抽成跨包公共模块：两个实现位于不同包，当前只有两个调用点，强行共享会增加耦合。

关闭步骤：

1. 标记实例正在关闭，拒绝新的请求。
2. 关闭 stdin，让遵守 stdio 生命周期的子进程先自行退出。
3. 如果子进程仍运行，发送 `SIGTERM`。
4. 等待 `exit`，最多 5 秒。
5. 超时且 `exitCode === null`、`signalCode === null` 时发送 `SIGKILL`。
6. 再次等待 `exit` 后完成清理；所有 pending request 只拒绝一次。

不能使用 `proc.killed` 判断是否退出。该字段只表示 Node 已经成功发送过信号。

#### 5.2 应用退出

- Electron `before-quit` 阶段等待 `ConversationService.stop()`，完成可等待的正常关闭。
- `process.once("exit")` 只保留同步、尽力而为的兜底，不承担主要清理职责。
- MCP 连接被配置删除或替换时，同样走可等待的 `close()`。

#### 5.3 验证

为 fixture 增加一种“忽略 `SIGTERM`”模式，分别验证：

- 正常子进程收到 EOF/SIGTERM 后退出。
- 忽略 SIGTERM 的子进程在超时后收到 SIGKILL。
- 连续 start/stop 不遗留旧进程，也不会让旧进程的 `exit` 事件清空新进程状态。
- 被终止时所有等待中的 RPC 都得到一次明确错误。

### Phase 2：生成可独立运行的 macOS 应用

#### 5.4 运行资源布局

打包产物使用固定布局：

```text
Contents/Resources/runtime/
	agent/
		package.json
		dist/bundle/cli.js
		dist/bundle/chunks/*.js
		dist/modes/interactive/{theme,assets}/
		dist/core/export-html/
		docs/
		examples/
		node_modules/{jiti,@earendil-works/chord,@silvia-odwyer/photon-node}/
  extensions/mcp/
    index.ts
    config.ts
    mcp-client.ts
```

Agent CLI 的 `dist/bundle/cli.js` 会加载同目录的 `chunks`，并通过 Coding Agent package 根目录定位主题、文档与少量外部运行依赖，因此运行资源保留最小 package 布局，不能只复制入口文件。MCP 扩展保留为自包含源码目录，因为现有扩展加载器已经支持 `index.ts`；不额外建立第二套 MCP bundle。

#### 5.5 路径解析

增加一个桌面主进程内部的 `resolveRuntimeAssets()`：

- `app.isPackaged === true`：只从 `process.resourcesPath/runtime` 读取。
- 开发模式：继续读取仓库构建产物和源码扩展。
- `PI_DESKTOP_AGENT_CLI`、`PI_DESKTOP_MCP_EXTENSION` 只作为开发和诊断覆盖项。
- 任一必需资源缺失时，在启动阶段返回可操作错误，不能静默关闭 MCP 或显示空白聊天页。

不要继续用 `process.cwd()` 作为生产回退。用户从 Finder 启动应用时，工作目录不受项目控制。

#### 5.6 打包脚本

新增单一入口，例如 `npm run desktop:package:mac`：

1. 构建 Coding Agent CLI。
2. 构建桌面 main、preload 和 renderer。
3. 将 CLI 和 MCP 扩展复制为 `extraResources`。
4. 生成 unpacked app、DMG 和 ZIP。
5. 校验包内必需文件存在。

签名与 notarization 使用环境变量注入证书，不把凭据写入仓库。没有签名凭据时只允许生成明确标记的本地开发包。

#### 5.7 打包后冒烟测试

测试必须启动 unpacked app，而不是再次运行开发脚本：

- 使用临时 `HOME` 和 user data 目录，避免读取开发者真实配置。
- 等待聊天输入框进入可用状态，证明打包后的 Agent CLI 成功返回 `get_state`。
- 打开插件页和技能页，确认 preload IPC 正常。
- 退出应用后确认 Agent 和 fixture MCP 进程均不存在。
- 不发送模型请求，不依赖 API key，不产生付费调用。

### Phase 3：收紧插件安装与配置安全

#### 5.8 固定插件版本

- 内置目录中的每个 npm 包使用精确版本，禁止 `@latest` 和隐式 latest。
- 版本升级通过代码评审完成，不在应用运行时自动升级。
- 目录元数据增加 `packageVersion`，详情页展示实际将执行的包与版本。

锁定版本解决可复现性，不等于信任包。所有 `stdio` 插件仍按本地程序处理。

#### 5.9 权限规则

- 只要配置会启动本地进程，就必须在首次安装时确认。
- 文件读写额外显示授权目录。
- 自定义命令明确标记“未审核”，展示完整可执行文件和参数后再保存。
- 风险等级只影响文案强度，不再决定是否跳过确认。

#### 5.10 意图型 IPC

用以下操作替代渲染端提交完整服务器映射：

- `plugin:list`
- `plugin:installBuiltin(id, configuration)`
- `plugin:addCustom(definition)`
- `plugin:remove(name)`
- `plugin:test(name)`

插件目录和配置校验放在主进程。每次修改都重新读取最新文件并只变更目标条目，避免两个页面状态覆盖彼此的配置。

#### 5.11 配置文件权限与临时文件

- `mcp-servers.json`、备份和临时文件使用仅当前用户可读写的权限。
- 临时文件名包含进程 ID 和随机值，避免并发保存共用固定 `.tmp`。
- 临时文件必须与目标文件位于同一目录，保持 rename 的原子性。
- 读取失败时阻止写入，不能把损坏文件当作空配置覆盖。

#### 5.12 凭据

当前内置目录没有需要 token 的插件，因此凭据存储不阻塞最先发布的六个插件。但自定义配置可能包含 Authorization header 或 secret 环境变量，需要在允许账号型插件前完成以下机制：

1. 主进程识别用户明确标记为敏感的字段，不依赖字段名猜测自动迁移。
2. 使用 Electron `safeStorage` 加密，并在独立文件中保存密文；配置文件只保存 secret reference。
3. 启动 Agent 时，主进程在内存中解析引用，并通过当前已经支持的 `PI_MCP_SERVERS` 覆盖把解析后的配置只传给 Agent 子进程。
4. Probe 使用同一解析函数；日志、错误和 renderer IPC 永不返回明文。
5. `safeStorage` 不可用时拒绝保存新凭据，但仍允许保存不含凭据的配置。

已有明文配置不静默改写。界面提示风险，由用户执行一次“保护凭据”迁移，迁移成功后再原子替换原配置。

### Phase 4：让技能页使用 Agent 的真实加载结果

#### 5.13 RPC

新增只读 `get_skills` RPC，直接读取：

```ts
session.resourceLoader.getSkills()
```

返回最小展示字段：

```ts
interface RpcSkillInfo {
  name: string;
  description: string;
  filePath: string;
  scope: "user" | "project" | "temporary";
  source: string;
  disableModelInvocation: boolean;
}

interface RpcSkillsResult {
  skills: RpcSkillInfo[];
  diagnostics: Array<{
    type: string;
    message: string;
    path?: string;
  }>;
}
```

不要在 RPC 中重新扫描目录，也不要把完整 `Skill` 内部对象直接暴露给桌面端。

#### 5.14 桌面技能页

- 删除桌面端自建的递归发现逻辑。
- 技能页从当前 Agent 请求 `get_skills`。
- `user` 映射为“个人”，`project` 映射为“项目”，`temporary` 显示来源名称，不错误归类。
- 有诊断时展示数量和可展开的路径/原因；不能继续静默丢弃损坏技能。
- “添加”仍只负责打开个人技能目录。用户返回页面后提供显式“刷新”，刷新 Agent resources 后再次读取技能。

为保持修改边界清晰，实施这一阶段时把 `SkillsPanel` 从 `McpPanel.tsx` 移到独立文件；不同时拆分其他聊天组件。

### Phase 5：减少首启等待和误导性交互

#### 5.15 MCP 首次连接

配置未变化的连接继续复用。确实需要新建或重连的服务器并发执行，但限制为最多 3 个：

- 连接任务只负责建立连接并返回工具列表。
- 所有任务完成后，按配置顺序注册工具，保证 system prompt 中的工具顺序稳定。
- 单个服务器失败不阻止其他服务器完成；失败状态沿用现有错误通知。
- 保留每个服务器 30 秒超时。

限制并发可以避免多个 `npx` 同时下载占满网络和磁盘；不引入通用任务队列依赖，使用当前模块内的小型 worker 循环即可。

#### 5.16 插件探测

- 进入插件页只读取配置，不调用 `probeMcpServers()`。
- 状态初始显示“已安装 · 未检测”。
- 用户点击单个插件的“测试连接”后，只启动该插件的临时 Probe。
- Probe 完成、失败、超时或页面关闭时都必须执行 `close()`。
- 测试结果只说明刚才的独立检测结果，不标记为“Agent 当前已连接”。

#### 5.17 未开放入口

“图像”“定时任务”“探索”以及当前没有路由语义的前进/后退按钮采用同一规则：

- 如果近期仍需保留布局，设置原生 `disabled`、降低视觉强调，并提供“暂未开放”的可访问说明。
- 如果没有产品展示要求，直接隐藏是更简单的选择。

本设计默认保留并禁用，因为当前界面已经把这些入口作为整体导航的一部分。

## 6. 测试策略

### 6.1 定向单元与集成测试

| 范围 | 必测行为 |
|---|---|
| AgentProcess | 正常退出、超时强杀、重复 stop、旧进程事件隔离 |
| MCP stdio transport | EOF、SIGTERM、SIGKILL、pending request 清理 |
| MCP extension | 连接复用、配置变化、删除连接、最多 3 个并发、注册顺序稳定 |
| MCP config | 意图型增删、并发写不覆盖、损坏配置阻止保存、文件权限 |
| Plugin catalog | 所有 stdio 插件均固定版本且要求确认 |
| RPC skills | 返回 Agent 已加载技能、scope 和 diagnostics |
| Desktop skills | 搜索、范围筛选、刷新、诊断展示 |
| Plugin page | 首次渲染不 Probe、手动测试只探测目标服务器 |

### 6.2 桌面端流程测试

使用真实 Electron 窗口覆盖以下无模型调用流程：

1. 启动后聊天输入框可用。
2. 点击“新聊天”立即显示空白就绪页，不创建重复持久化记录。
3. 插件/技能在同一主页面切换，不出现弹窗。
4. 打开插件页不会产生新的 MCP 子进程。
5. 未开放入口无法点击。
6. 关闭窗口后所有子进程退出。

测试优先通过 role、label 和可见文本定位，不为测试给生产组件批量增加专用 ID。

### 6.3 每阶段验证命令

代码实现阶段至少运行：

```bash
npm run check
```

以及本阶段修改到的具体 Vitest 文件。按照仓库规则，不运行完整 Vitest 套件；打包命令和打包后冒烟测试只在 Phase 2 实施时运行。

## 7. 实施顺序与提交边界

每个阶段可独立验证和回滚，建议按以下顺序实施：

1. `fix(coding-agent): restore MCP checks`
2. `fix(agent): terminate desktop and MCP child processes reliably`
3. `feat(agent): package desktop runtime assets for macOS`
4. `fix(agent): secure desktop plugin installation`
5. `fix(agent): source desktop skills from Agent RPC`
6. `fix(agent): avoid redundant MCP startup work`
7. `fix(agent): disable unavailable desktop navigation`

提交时只暂存对应阶段文件，不能把当前全部 26 个文件一次性加入同一提交。

## 8. 总体验收标准

以下条件全部满足后，才可认为本设计完成：

- 全新临时用户目录下，unpacked macOS 应用可以启动且聊天输入框可用。
- 应用不依赖源码仓库路径或启动工作目录。
- 连续启动、切换运行配置和退出后，没有遗留 Agent 或 fixture MCP 进程。
- 内置 npm 插件全部使用精确版本；任何本地进程安装前都展示确认。
- 打开插件页不会自动启动 MCP；手动检测只启动目标服务器并在结束后退出。
- 三个慢 MCP 的首连耗时接近最慢单个服务器耗时，而不是三者之和；最多同时连接 3 个。
- 技能页内容、冲突结果和诊断信息与当前 Agent runtime 一致。
- 未实现入口不能触发空白页或让用户误以为应用卡死。
- `npm run check`、相关定向测试、`git diff --check` 和打包后冒烟测试全部通过。

## 9. 风险与回滚

| 风险 | 控制方式 | 回滚边界 |
|---|---|---|
| 打包资源路径错误导致应用无法启动 | packaged smoke 必须直接启动 unpacked app | 回滚 Phase 2，不影响开发模式 |
| 强制终止误杀新进程 | closure 绑定具体 child，并验证 child identity | 回滚 Phase 1 |
| 并发连接改变工具顺序 | 连接并发、注册按配置顺序串行 | 回滚 Phase 5.15 |
| 新 IPC 与旧配置不兼容 | 保持磁盘 schema，主进程只做意图型修改 | 回滚 renderer/main IPC |
| 凭据迁移造成丢失 | 不自动迁移；加密成功后才原子替换 | 保留原配置备份 |
| Agent 未启动时技能页不可用 | 展示 Agent 启动错误和重试，不回退到另一套扫描器 | 修复 Agent 启动问题 |

## 10. 设计结论

本方案不增加新的业务功能，也不重写现有架构。它通过五个有限改动把当前功能补齐：可靠管理子进程、把运行资源真正放进安装包、收紧本地插件执行权限、让技能页读取 Agent 的真实状态，以及去掉不必要的 MCP 冷启动。

实施时应严格按阶段验证。任何阶段如果不能用对应测试证明目标已经达成，就不进入下一阶段，也不以扩大重构范围代替修复具体问题。

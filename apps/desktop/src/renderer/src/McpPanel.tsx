import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	InstalledSkill,
	InstalledSkillScope,
	McpConfigProblem,
	McpProbeResult,
	McpServerConfig,
	McpServers,
} from "../../shared/ipc.ts";
import { inferServerName, parseMcpServers, splitCommandLine } from "../../shared/mcp.ts";
import {
	catalogById,
	type PluginCatalogEntry,
	type PluginPermission,
	type PluginRisk,
	permissionChip,
	permissionLabel,
	permissionsForConfig,
	pluginCatalog,
	riskLabels,
} from "./plugin-catalog.ts";

type ProbeState = McpProbeResult | "connecting";

interface PendingInstall {
	busyKey: string;
	configuration?: Record<string, string>;
	displayName: string;
	names: string[];
	permissions: PluginPermission[];
	reviewed: boolean;
	risk: PluginRisk;
	servers: McpServers;
}

function uniqueName(base: string, taken: McpServers): string {
	if (!taken[base]) return base;
	for (let index = 2; ; index += 1) {
		const candidate = `${base}-${index}`;
		if (!taken[candidate]) return candidate;
	}
}

type PasteResult = { ok: true; servers: McpServers } | { ok: false; error: string };

function parsePasted(text: string): PasteResult {
	const trimmed = text.trim();
	if (!trimmed) return { error: "请输入服务器地址、启动命令或 JSON 配置", ok: false };

	if (!trimmed.startsWith("{")) {
		if (/^https?:\/\//i.test(trimmed)) {
			const config: McpServerConfig = { type: "http", url: trimmed };
			return { ok: true, servers: { [inferServerName(config)]: config } };
		}
		const [command, ...args] = splitCommandLine(trimmed);
		if (!command) return { error: "请输入服务器地址、启动命令或 JSON 配置", ok: false };
		const config: McpServerConfig = { type: "stdio", command, ...(args.length > 0 ? { args } : {}) };
		return { ok: true, servers: { [inferServerName(config)]: config } };
	}

	try {
		const servers = parseMcpServers(JSON.parse(trimmed));
		if (!servers) return { ok: false, error: "没有解析出 MCP 服务器，请检查 JSON 内容" };
		return { ok: true, servers };
	} catch (reason) {
		return { ok: false, error: `JSON 解析失败：${reason instanceof Error ? reason.message : String(reason)}` };
	}
}

function PluginGlyph({ name, preset }: { name: string; preset?: PluginCatalogEntry }) {
	return (
		<span className="mcp-plugin-glyph" data-tone={preset?.tone ?? "neutral"}>
			{preset?.glyph ?? name.slice(0, 1).toUpperCase()}
		</span>
	);
}

function SearchIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24">
			<circle cx="11" cy="11" r="6.5" />
			<path d="m16 16 4 4" />
		</svg>
	);
}

function PlusIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24">
			<path d="M12 5v14M5 12h14" />
		</svg>
	);
}

function InstalledIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24">
			<path d="m6 12 4 4 8-9" />
		</svg>
	);
}

function SkillGlyph() {
	return (
		<span className="skill-glyph">
			<svg aria-hidden="true" viewBox="0 0 40 40">
				<path d="m20 3 14 8-14 8L6 11 20 3Z" />
				<path d="m6 11 14 8v17L6 28V11Z" />
				<path d="m34 11-14 8v17l14-8V11Z" />
			</svg>
		</span>
	);
}

type SkillFilter = "all" | InstalledSkillScope;

function SkillsPanel() {
	const [skills, setSkills] = useState<InstalledSkill[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string>();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<SkillFilter>("all");

	useEffect(() => {
		void window.piDesktop
			.listSkills()
			.then(setSkills)
			.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
			.finally(() => setLoaded(true));
	}, []);

	const visibleSkills = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();
		return skills.filter((skill) => {
			if (filter !== "all" && skill.scope !== filter) return false;
			if (!normalizedQuery) return true;
			return [skill.name, skill.description].some((value) => value.toLowerCase().includes(normalizedQuery));
		});
	}, [filter, query, skills]);

	return (
		<div className="mcp-panel-body">
			<div className="mcp-page-content">
				<header className="mcp-panel-header">
					<div>
						<h1 id="skill-page-title">技能</h1>
						<p>通过任务专用技能扩展 Agent 的能力</p>
					</div>
				</header>

				<label className="mcp-search">
					<SearchIcon />
					<input
						aria-label="搜索技能"
						placeholder="搜索技能"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>

				<section className="mcp-section">
					<div className="mcp-section-heading skill-section-heading">
						<h3>已安装</h3>
						<span>{skills.length}</span>
					</div>
					<fieldset aria-label="技能范围" className="skill-filters">
						{(
							[
								["all", "全部"],
								["personal", "个人"],
								["project", "项目"],
							] as const
						).map(([value, label]) => (
							<button
								aria-pressed={filter === value}
								className={filter === value ? "active" : ""}
								key={value}
								type="button"
								onClick={() => setFilter(value)}
							>
								{label}
							</button>
						))}
					</fieldset>

					{!loaded ? (
						<div className="mcp-loading">正在加载技能…</div>
					) : error ? (
						<div className="mcp-empty">技能加载失败：{error}</div>
					) : visibleSkills.length === 0 ? (
						<div className="mcp-empty">
							{skills.length === 0
								? "还没有安装技能。点击右上角“添加”，将技能文件放入个人技能目录。"
								: "没有找到符合条件的技能"}
						</div>
					) : (
						<div className="skill-grid">
							{visibleSkills.map((skill) => (
								<article className="skill-card" key={skill.path} title={skill.path}>
									<SkillGlyph />
									<div>
										<div className="skill-card-title">
											<strong>{skill.name}</strong>
											<span>{skill.scope === "personal" ? "个人" : "项目"}</span>
										</div>
										<p>{skill.description}</p>
									</div>
								</article>
							))}
						</div>
					)}
				</section>
			</div>
		</div>
	);
}

export function McpPanel() {
	const [activeTab, setActiveTab] = useState<"plugins" | "skills">("plugins");
	const [servers, setServers] = useState<McpServers>({});
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [busyName, setBusyName] = useState<string>();
	const [query, setQuery] = useState("");
	const [customOpen, setCustomOpen] = useState(false);
	const [pasted, setPasted] = useState("");
	const [presetValues, setPresetValues] = useState<Record<string, string>>({});
	const [problem, setProblem] = useState<McpConfigProblem>();
	const [statuses, setStatuses] = useState<Record<string, ProbeState>>({});
	const [detailName, setDetailName] = useState<string>();
	const [pending, setPending] = useState<PendingInstall>();

	const probe = useCallback(async (names: string[]) => {
		if (names.length === 0) return;
		setStatuses((current) => {
			const next = { ...current };
			for (const name of names) next[name] = "connecting";
			return next;
		});
		try {
			const results = await window.piDesktop.probeMcpServers(names);
			setStatuses((current) => ({ ...current, ...results }));
		} catch (reason) {
			const message = reason instanceof Error ? reason.message : String(reason);
			setStatuses((current) => {
				const next = { ...current };
				for (const name of names) next[name] = { status: "error", message };
				return next;
			});
		}
	}, []);

	const applyList = useCallback(
		(result: { problem?: McpConfigProblem; servers: McpServers }) => {
			setServers(result.servers);
			setProblem(result.problem);
			setStatuses({});
			if (!result.problem) void probe(Object.keys(result.servers));
		},
		[probe],
	);

	useEffect(() => {
		void window.piDesktop
			.listMcpServers()
			.then(applyList)
			.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
			.finally(() => setLoaded(true));
	}, [applyList]);

	const visiblePresets = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) return pluginCatalog;
		return pluginCatalog.filter((preset) =>
			[preset.id, preset.displayName, preset.summary, preset.category].some((value) =>
				value.toLowerCase().includes(normalizedQuery),
			),
		);
	}, [query]);

	const saveServers = async (next: McpServers, pendingKey: string, successMessage: string): Promise<boolean> => {
		setBusyName(pendingKey);
		setError(undefined);
		setNotice(undefined);
		try {
			await window.piDesktop.saveMcpServers(next);
			setServers(next);
			setPending(undefined);
			setNotice(successMessage);
			return true;
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			return false;
		} finally {
			setBusyName(undefined);
		}
	};

	/** Name conflicts are resolved here, so the confirmation card shows the final names. */
	const installStaged = async (install: PendingInstall) => {
		const next = { ...servers };
		for (const [name, config] of Object.entries(install.servers)) {
			next[uniqueName(name, next)] = config;
		}
		if (await saveServers(next, install.busyKey, `已安装 ${install.displayName}`)) {
			void probe(install.names);
		}
	};

	const requestInstall = (install: PendingInstall) => {
		setError(undefined);
		// Low-risk built-ins install in one click; anything else shows its
		// permissions first.
		if (install.risk === "low") void installStaged(install);
		else setPending(install);
	};

	const installPreset = (preset: PluginCatalogEntry) => {
		if (servers[preset.id] || problem) return;
		const value = presetValues[preset.id]?.trim();
		if (preset.input && !value) {
			setNotice(undefined);
			setError(`请先${preset.input.label}`);
			return;
		}
		const configuration = preset.input && value ? { directory: value } : undefined;
		requestInstall({
			busyKey: preset.id,
			configuration,
			displayName: preset.displayName,
			names: [preset.id],
			permissions: preset.permissions,
			reviewed: true,
			risk: preset.risk,
			servers: {
				[preset.id]: {
					type: "stdio",
					command: preset.command,
					args: preset.input && value ? [...preset.args, value] : preset.args,
				},
			},
		});
	};

	const addPasted = () => {
		const result = parsePasted(pasted);
		if (!result.ok) {
			setNotice(undefined);
			setError(result.error);
			return;
		}

		// Custom servers are unreviewed, so they always show permissions first.
		const names: string[] = [];
		const taken = { ...servers };
		const permissions: PluginPermission[] = [];
		for (const [serverName, config] of Object.entries(result.servers)) {
			const name = uniqueName(serverName, taken);
			taken[name] = config;
			names.push(name);
			permissions.push(...permissionsForConfig(config));
		}

		setError(undefined);
		setPending({
			busyKey: "custom",
			displayName: names.join("、"),
			names,
			permissions,
			reviewed: false,
			risk: "high",
			servers: result.servers,
		});
	};

	const pickDirectory = async (presetId: string) => {
		setError(undefined);
		try {
			const directory = await window.piDesktop.selectDirectory();
			if (!directory) return;
			setPresetValues((current) => ({ ...current, [presetId]: directory }));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	};

	const removeServer = async (serverName: string) => {
		const next = { ...servers };
		delete next[serverName];
		if (await saveServers(next, serverName, `已移除 ${catalogById.get(serverName)?.displayName ?? serverName}`)) {
			setStatuses((current) => {
				const remaining = { ...current };
				delete remaining[serverName];
				return remaining;
			});
		}
	};

	const restoreBackup = async () => {
		setBusyName("restore");
		setError(undefined);
		try {
			applyList(await window.piDesktop.restoreMcpBackup());
			setNotice("已用备份恢复配置");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setBusyName(undefined);
		}
	};

	const statusOf = (serverName: string): ProbeState | undefined => statuses[serverName];

	const renderStatus = (serverName: string) => {
		const status = statusOf(serverName);
		if (!status) return null;
		if (status === "connecting") {
			return <span className="mcp-status connecting">检测中…</span>;
		}
		if (status.status === "ready") {
			const count = status.toolCount ?? 0;
			return <span className="mcp-status ready">{count > 0 ? `可用 · ${count} 个工具` : "可用"}</span>;
		}
		return <span className="mcp-status error">连接失败</span>;
	};

	return (
		<main aria-labelledby={activeTab === "plugins" ? "plugin-page-title" : "skill-page-title"} className="mcp-page">
			<header className="mcp-page-toolbar">
				<nav aria-label="扩展类型" className="mcp-page-tabs">
					<button
						aria-current={activeTab === "plugins" ? "page" : undefined}
						className={activeTab === "plugins" ? "active" : ""}
						type="button"
						onClick={() => setActiveTab("plugins")}
					>
						插件
					</button>
					<button
						aria-current={activeTab === "skills" ? "page" : undefined}
						className={activeTab === "skills" ? "active" : ""}
						type="button"
						onClick={() => setActiveTab("skills")}
					>
						技能
					</button>
				</nav>
				<div className="mcp-header-actions">
					<button
						className="mcp-custom-toggle"
						disabled={activeTab === "plugins" && Boolean(problem)}
						title={activeTab === "skills" ? "打开个人技能目录" : undefined}
						type="button"
						onClick={() => {
							if (activeTab === "skills") {
								void window.piDesktop.revealSkillsDirectory();
								return;
							}
							setCustomOpen((open) => !open);
						}}
					>
						<PlusIcon />
						添加
					</button>
				</div>
			</header>

			{activeTab === "skills" ? (
				<SkillsPanel />
			) : (
				<div className="mcp-panel-body">
					<div className="mcp-page-content">
						<header className="mcp-panel-header">
							<div>
								<h1 id="plugin-page-title">插件</h1>
								<p>在你常用的工具中与 Agent 协作</p>
							</div>
						</header>
						{problem && (
							<section aria-live="assertive" className="mcp-problem" role="alert">
								<h3>配置文件无法读取</h3>
								<p>{problem.message}</p>
								<code>{problem.path}</code>
								<p className="mcp-note">为避免覆盖你原有的配置，安装和移除已暂时停用。</p>
								<div className="mcp-problem-actions">
									<button type="button" onClick={() => void window.piDesktop.revealMcpConfig()}>
										打开文件位置
									</button>
									<button
										disabled={!problem.backupAvailable || Boolean(busyName)}
										type="button"
										onClick={() => void restoreBackup()}
									>
										恢复备份
									</button>
								</div>
							</section>
						)}

						{pending && (
							<section className="mcp-confirm">
								<h3>安装 {pending.displayName}</h3>
								<p className="mcp-confirm-risk">
									{riskLabels[pending.risk]}
									{pending.reviewed ? "" : " · 未审核"}
								</p>
								<ul>
									{pending.permissions.map((permission) => (
										<li key={`${permission.type}-${JSON.stringify(permission)}`}>
											{permissionLabel(permission, pending.configuration)}
										</li>
									))}
								</ul>
								<p className="mcp-note">安装后 Agent 会在下次对话中加载它，并可调用它的工具。</p>
								<div className="mcp-confirm-actions">
									<button disabled={Boolean(busyName)} type="button" onClick={() => setPending(undefined)}>
										取消
									</button>
									<button
										className="primary"
										disabled={Boolean(busyName)}
										type="button"
										// biome-ignore lint/a11y/noAutofocus: the confirmation is a modal step.
										autoFocus
										onClick={() => void installStaged(pending)}
									>
										{busyName === pending.busyKey ? "安装中…" : "确认安装"}
									</button>
								</div>
							</section>
						)}

						<label className="mcp-search">
							<SearchIcon />
							<input
								aria-label="搜索插件"
								placeholder="搜索插件"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
							/>
						</label>

						{customOpen && (
							<section className="mcp-custom-card">
								<div className="mcp-section-heading">
									<div>
										<h3>添加自定义 MCP</h3>
										<p>支持服务器 URL、启动命令或 JSON 配置</p>
									</div>
								</div>
								<textarea
									aria-label="自定义 MCP 配置"
									placeholder={'https://example.com/mcp\n或 npx -y @example/mcp\n或粘贴 {"mcpServers": {...}}'}
									rows={4}
									value={pasted}
									onChange={(event) => setPasted(event.target.value)}
								/>
								<div className="mcp-custom-actions">
									<button type="button" onClick={() => setCustomOpen(false)}>
										取消
									</button>
									<button disabled={Boolean(busyName)} type="button" onClick={addPasted}>
										添加
									</button>
								</div>
							</section>
						)}

						{!loaded ? (
							<div className="mcp-loading">正在加载插件…</div>
						) : (
							<>
								<section className="mcp-section">
									<div className="mcp-section-heading">
										<h3>已安装</h3>
										<span>{Object.keys(servers).length}</span>
									</div>
									{Object.keys(servers).length === 0 ? (
										<div className="mcp-empty">还没有安装插件，从下方推荐中选择一个即可开始。</div>
									) : (
										<div className="mcp-installed-list">
											{Object.keys(servers).map((serverName) => {
												const preset = catalogById.get(serverName);
												const status = statusOf(serverName);
												const failure = status && status !== "connecting" ? status : undefined;
												const failed = failure?.status === "error";
												return (
													<div className="mcp-installed-item" key={serverName}>
														<PluginGlyph name={serverName} preset={preset} />
														<div>
															<strong>
																{preset?.displayName ?? serverName}
																{!preset && <span className="mcp-badge">自定义 · 未审核</span>}
															</strong>
															<span>{preset?.summary ?? "自定义 MCP 服务器"}</span>
															{renderStatus(serverName)}
														</div>
														<div className="mcp-installed-actions">
															{failed && (
																<>
																	<button
																		aria-label={`查看 ${serverName} 的错误详情`}
																		type="button"
																		onClick={() =>
																			setDetailName((current) =>
																				current === serverName ? undefined : serverName,
																			)
																		}
																	>
																		{detailName === serverName ? "收起" : "详情"}
																	</button>
																	<button
																		disabled={Boolean(busyName)}
																		type="button"
																		onClick={() => void probe([serverName])}
																	>
																		重试
																	</button>
																</>
															)}
															<button
																aria-label={`移除 ${preset?.displayName ?? serverName}`}
																className="mcp-remove"
																disabled={Boolean(busyName)}
																type="button"
																onClick={() => void removeServer(serverName)}
															>
																{busyName === serverName ? "…" : "移除"}
															</button>
														</div>
														{detailName === serverName && failed && (
															<div className="mcp-diagnostics">
																<p>{failure?.message}</p>
																{failure?.hint && <p>建议：{failure.hint}</p>}
																{failure?.detail && <pre>{failure.detail}</pre>}
															</div>
														)}
													</div>
												);
											})}
										</div>
									)}
								</section>

								<section className="mcp-section">
									<div className="mcp-section-heading">
										<div>
											<h3>{query ? "搜索结果" : "推荐插件"}</h3>
											{!query && <p>选择需要的能力，一键安装</p>}
										</div>
									</div>
									{visiblePresets.length === 0 ? (
										<div className="mcp-empty">没有找到相关插件</div>
									) : (
										<div className="mcp-market-grid">
											{visiblePresets.map((preset) => {
												const installed = Boolean(servers[preset.id]);
												const chosen = presetValues[preset.id]?.trim();
												return (
													<article className="mcp-market-card" key={preset.id}>
														<PluginGlyph name={preset.id} preset={preset} />
														<div className="mcp-market-copy">
															<div className="mcp-market-title">
																<strong>{preset.displayName}</strong>
																<span>{preset.category}</span>
															</div>
															<p>{preset.summary}</p>
															<p className="mcp-permissions">
																{preset.permissions.map(permissionChip).join(" · ")}
															</p>
															{preset.input && !installed && (
																<button
																	className="mcp-directory"
																	disabled={Boolean(problem)}
																	type="button"
																	onClick={() => void pickDirectory(preset.id)}
																>
																	{chosen ?? preset.input.label}
																</button>
															)}
														</div>
														<button
															aria-label={
																installed
																	? `${preset.displayName} 已安装`
																	: `安装 ${preset.displayName}`
															}
															className={installed ? "installed" : ""}
															disabled={installed || Boolean(busyName) || Boolean(problem)}
															type="button"
															onClick={() => installPreset(preset)}
														>
															{installed ? (
																<InstalledIcon />
															) : busyName === preset.id ? (
																"…"
															) : (
																<PlusIcon />
															)}
														</button>
													</article>
												);
											})}
										</div>
									)}
								</section>
							</>
						)}

						<div aria-live="polite" className="mcp-feedback">
							{notice && <p className="mcp-notice">{notice}，将在下次对话中生效。</p>}
							{error && <p className="mcp-error">{error}</p>}
						</div>
					</div>
				</div>
			)}
		</main>
	);
}

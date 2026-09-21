import { useCallback, useEffect, useMemo, useState } from "react";
import type { InstalledSkill, InstalledSkillScope, SkillDiagnostic } from "../../shared/ipc.ts";

type SkillFilter = "all" | InstalledSkillScope;

function SearchIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24">
			<circle cx="11" cy="11" r="6.5" />
			<path d="m16 16 4 4" />
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

function scopeLabel(skill: InstalledSkill): string {
	if (skill.scope === "personal") return "个人";
	if (skill.scope === "project") return "项目";
	return skill.source;
}

export function SkillsPanel() {
	const [skills, setSkills] = useState<InstalledSkill[]>([]);
	const [diagnostics, setDiagnostics] = useState<SkillDiagnostic[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string>();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<SkillFilter>("all");

	const load = useCallback(async (refresh: boolean) => {
		setError(undefined);
		if (refresh) setRefreshing(true);
		try {
			const result = refresh ? await window.piDesktop.refreshSkills() : await window.piDesktop.listSkills();
			setSkills(result.skills);
			setDiagnostics(result.diagnostics);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoaded(true);
			setRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void load(false);
	}, [load]);

	const visibleSkills = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();
		return skills.filter((skill) => {
			if (filter !== "all" && skill.scope !== filter) return false;
			if (!normalizedQuery) return true;
			return [skill.name, skill.description, skill.source].some((value) =>
				value.toLowerCase().includes(normalizedQuery),
			);
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
					<button disabled={refreshing} type="button" onClick={() => void load(true)}>
						{refreshing ? "刷新中…" : "刷新"}
					</button>
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
						<h3>已加载</h3>
						<span>{skills.length}</span>
					</div>
					<fieldset aria-label="技能范围" className="skill-filters">
						{(
							[
								["all", "全部"],
								["personal", "个人"],
								["project", "项目"],
								["temporary", "临时"],
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

					{diagnostics.length > 0 && (
						<details className="skill-diagnostics">
							<summary>{diagnostics.length} 个技能未能正常加载</summary>
							<ul>
								{diagnostics.map((diagnostic, index) => (
									<li key={`${diagnostic.path ?? diagnostic.message}-${index}`}>
										<strong>{diagnostic.message}</strong>
										{diagnostic.path && <code>{diagnostic.path}</code>}
									</li>
								))}
							</ul>
						</details>
					)}

					{!loaded ? (
						<div className="mcp-loading">正在加载技能…</div>
					) : error ? (
						<div className="mcp-empty">技能加载失败：{error}</div>
					) : visibleSkills.length === 0 ? (
						<div className="mcp-empty">
							{skills.length === 0
								? "Agent 当前没有加载技能。点击右上角“添加”，将技能文件放入个人技能目录。"
								: "没有找到符合条件的技能"}
						</div>
					) : (
						<div className="skill-grid">
							{visibleSkills.map((skill) => (
								<article className="skill-card" key={`${skill.path}-${skill.name}`} title={skill.path}>
									<SkillGlyph />
									<div>
										<div className="skill-card-title">
											<strong>{skill.name}</strong>
											<span>{scopeLabel(skill)}</span>
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

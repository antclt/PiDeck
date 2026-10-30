import { Bot, BrainCircuit, GitFork, Monitor, Settings2, ShieldCheck, Sparkles, Terminal, Users } from "lucide-react";

/**
 * ACP 配置项图标：按 category + id 关键词区分模型 / 思考 / 权限 / 工具模式 / 沙箱 / 多任务 / 代理。
 *
 * 为什么不能只看 category：CodeBuddy 2.178.1 起把 PTC/Minimal/Creator 从 agent 维度搬到
 * toolMode，mode / sandbox / multitask 等也常缺 category，只按 category 分会让一整排 chip
 * 全是同一个齿轮，脱离 tooltip 完全读不出在配置什么。
 *
 * 顺序有讲究：model 必须判在 mode 之前——"model".includes("mode") 为真，写反会把模型 chip 画成盾牌。
 */
export function AcpConfigGlyph(props: { option: { id: string; category?: string }; className?: string }) {
	const key = `${props.option.category ?? ""} ${props.option.id}`.toLowerCase();
	const Icon = key.includes("thought")
		? BrainCircuit
		: key.includes("toolmode") || key.includes("codemode") || key.includes("code_mode")
			? Terminal
			: key.includes("sandbox")
				? Monitor
				: key.includes("multitask")
					? Users
					: key.includes("delegate")
						? GitFork
						: key.includes("agent")
							? Bot
							: key.includes("model")
								? Sparkles
								: key.includes("mode")
									? ShieldCheck
									: Settings2;
	return <Icon className={props.className ?? "size-[15px] shrink-0 text-muted-foreground"} aria-hidden="true" />;
}

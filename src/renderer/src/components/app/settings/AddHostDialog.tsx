import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, ChevronDown, FileCode, Server, TerminalSquare } from "lucide-react";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";
import { Label } from "../../ui-shadcn/label";
import type { RemoteHostAddInput, RemoteHostConfigCandidate } from "../../../../../shared/types/remoteHost";

/** 跳过原因是稳定枚举；这里显式映射而不是拼接 key，否则远端回来的任意字符串会拼出不存在的 key。 */
function skipReasonLabel(reason: string): string {
	switch (reason) {
		case "wildcard":
			return t("settings.connections.add.skipReason.wildcard");
		case "invalid":
			return t("settings.connections.add.skipReason.invalid");
		case "unsupported-directive":
			return t("settings.connections.add.skipReason.unsupported-directive");
		default:
			return reason;
	}
}

type AuthMode = "agent" | "key";

/** 表单初值：端口默认 22，认证默认交给 ssh-agent / 默认密钥（与 Transport 的 BatchMode 一致）。 */
const EMPTY_FORM = {
	label: "",
	hostName: "",
	port: "22",
	user: "",
	auth: "agent" as AuthMode,
	identityFile: "",
};
type FormState = typeof EMPTY_FORM;

/**
 * 「新建连接」面板。
 *
 * 结构照 ZCode 的远程配置面板：**类型切换 + 实时目标预览 + 表单 + 从 SSH config 导入**。
 * 类型切换里只有 SSH 能真正工作——WSL/Docker 在 PiDeck 还属于后续能力，因此显示为 disabled
 * 并标注「暂未接入」，而不是给一个点进去必然失败的入口。
 *
 * 认证只提供「自动（ssh-agent/默认密钥）」与「指定私钥」：底层 OpenSSH 调用固定
 * `BatchMode=yes` / `NumberOfPasswordPrompts=0`，密码与私钥口令都没有可用的传递通道，
 * 所以面板上不放密码输入框（ZCode 的密码框依赖它自己的凭据托管）。
 *
 * 保存仍是「一次动作」：主进程在同一次 add 里完成首次 host key 信任（TOFU）并落盘 pin，
 * 成功后由调用方立刻发起连接，没有第二步「核对指纹」。
 */
export function AddHostDialog(props: { onClose: () => void; onSubmitted: (hostId: string, label: string) => void }) {
	const [candidates, setCandidates] = useState<RemoteHostConfigCandidate[]>([]);
	const [skipped, setSkipped] = useState<{ alias: string; reason: string }[]>([]);
	const [currentUser, setCurrentUser] = useState("");
	const [scanNote, setScanNote] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const [query, setQuery] = useState("");
	const [form, setForm] = useState<FormState>(EMPTY_FORM);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void (async () => {
			const result = await desktopApi.remoteHosts.scanConfig();
			if (!active) return;
			if (!result.ok) {
				// 功能被关闭时直接说明；config 读不到时表单仍然可用，不把用户堵在错误页。
				setScanNote(result.code === "REMOTE_FEATURE_DISABLED" ? t("settings.connections.add.disabled") : t("settings.connections.add.scanFailed"));
				return;
			}
			setCandidates(result.candidates);
			setSkipped(result.skipped);
			setCurrentUser(result.user);
		})();
		return () => {
			active = false;
		};
	}, []);

	/** 表单唯一的校验点（与 ZCode 的 collectRemoteFormFieldErrors 同一思路：先报第一个错，不发请求）。 */
	const validate = useCallback((): RemoteHostAddInput | string => {
		const label = form.label.trim();
		const hostName = form.hostName.trim();
		if (label.length === 0 || hostName.length === 0) return t("settings.connections.add.required");
		const rawPort = form.port.trim();
		const port = rawPort.length === 0 ? undefined : Number(rawPort);
		if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) return t("settings.connections.add.badPort");
		const identityFile = form.auth === "key" ? form.identityFile.trim() : "";
		if (form.auth === "key" && identityFile.length === 0) return t("settings.connections.add.keyRequired");
		const user = form.user.trim();
		return {
			label,
			hostName,
			...(port === undefined ? {} : { port }),
			...(user.length > 0 ? { user } : {}),
			...(identityFile.length > 0 ? { identityFile } : {}),
		};
	}, [form]);

	const submit = useCallback(async () => {
		const input = validate();
		if (typeof input === "string") {
			setError(input);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await desktopApi.remoteHosts.add(input);
			// 回传 label 让连接进度屏显示人话，而不是 UUID。
			if (result.ok) props.onSubmitted(result.hostId, input.label);
			else setError(t("settings.connections.add.failed", { code: result.code }));
		} finally {
			setBusy(false);
		}
	}, [props, validate]);

	/** 选中一条 config 候选 = 把字段填进表单，仍然由用户确认后再添加（不隐式提交）。 */
	const applyCandidate = useCallback((candidate: RemoteHostConfigCandidate) => {
		setForm({
			label: candidate.alias,
			hostName: candidate.hostName,
			port: candidate.port === null ? "22" : String(candidate.port),
			user: candidate.user,
			auth: candidate.identityFile === null ? "agent" : "key",
			identityFile: candidate.identityFile ?? "",
		});
		setError(null);
		setImporting(false);
		setQuery("");
	}, []);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return candidates;
		return candidates.filter((candidate) => `${candidate.alias} ${candidate.hostName} ${candidate.user}`.toLowerCase().includes(needle));
	}, [candidates, query]);

	const previewHost = form.hostName.trim();
	const previewUser = form.user.trim();
	const previewPort = form.port.trim() || "22";
	const preview = previewHost.length === 0 ? t("settings.connections.add.previewPlaceholder") : `${previewUser.length > 0 ? `${previewUser}@` : ""}${previewHost}:${previewPort}`;

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
		>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<div className="flex flex-wrap items-center gap-2">
						<DialogTitle>{t("settings.connections.add.title")}</DialogTitle>
						<span className="rounded border border-border-subtle px-1.5 py-0.5 text-micro text-muted-foreground">SSH</span>
					</div>
					<DialogDescription className={cn("break-all font-mono text-label", previewHost.length === 0 ? "text-muted-foreground" : "text-foreground")}>{preview}</DialogDescription>
				</DialogHeader>

				{/* 类型切换：SSH 可用；WSL/Docker 是 PiDeck 的后续能力，标注而不是隐藏。 */}
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div role="group" aria-label={t("settings.connections.add.typeLabel")} className="flex w-fit overflow-hidden rounded-lg border border-input">
						<button type="button" aria-pressed="true" className="inline-flex min-h-8 items-center gap-1.5 bg-accent px-3 text-body font-medium text-accent-foreground">
							<Server className="size-3.5" aria-hidden="true" />
							{t("settings.connections.add.kind.ssh")}
						</button>
						<button
							type="button"
							aria-pressed="false"
							disabled
							aria-label={`${t("settings.connections.add.kind.wsl")} — ${t("settings.connections.add.kindUnavailable")}`}
							title={t("settings.connections.add.kindUnavailable")}
							className="inline-flex min-h-8 items-center gap-1.5 border-l border-input px-3 text-body text-muted-foreground opacity-50"
						>
							<TerminalSquare className="size-3.5" aria-hidden="true" />
							{t("settings.connections.add.kind.wsl")}
						</button>
						<button
							type="button"
							aria-pressed="false"
							disabled
							aria-label={`${t("settings.connections.add.kind.docker")} — ${t("settings.connections.add.kindUnavailable")}`}
							title={t("settings.connections.add.kindUnavailable")}
							className="inline-flex min-h-8 items-center gap-1.5 border-l border-input px-3 text-body text-muted-foreground opacity-50"
						>
							<Box className="size-3.5" aria-hidden="true" />
							{t("settings.connections.add.kind.docker")}
						</button>
					</div>
					<Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setImporting((open) => !open)} aria-expanded={importing}>
						<FileCode className="size-4" aria-hidden="true" />
						{t("settings.connections.add.import")}
						<ChevronDown className={cn("size-3.5 transition-transform", importing && "rotate-180")} aria-hidden="true" />
					</Button>
				</div>

				{importing ? (
					<div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-panel p-2">
						<Input autoFocus value={query} placeholder={t("settings.connections.add.importSearch")} aria-label={t("settings.connections.add.importSearch")} onChange={(event) => setQuery(event.target.value)} />
						{filtered.length === 0 ? <p className="px-1 py-2 text-label text-muted-foreground">{t("settings.connections.add.importEmpty")}</p> : null}
						<ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
							{filtered.map((candidate) => (
								<li key={candidate.alias}>
									<button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body hover:bg-bg-hover" onClick={() => applyCandidate(candidate)}>
										<span className="min-w-0 flex-1 truncate font-medium">{candidate.alias}</span>
										<span className="shrink-0 font-mono text-label text-muted-foreground">
											{candidate.user.length > 0 ? candidate.user : currentUser}@{candidate.hostName}
											{candidate.port !== null ? `:${candidate.port}` : ""}
										</span>
									</button>
								</li>
							))}
						</ul>
						{/* 被跳过的条目要说明原因：静默少一项会让用户以为自己的配置丢了。 */}
						{skipped.length > 0 ? (
							<details className="px-1 text-label text-muted-foreground">
								<summary className="cursor-pointer select-none">
									{t("settings.connections.add.skipped", {
										count: String(skipped.length),
									})}
								</summary>
								<ul className="mt-1 flex flex-col gap-0.5">
									{skipped.map((entry) => (
										<li key={`${entry.alias}-${entry.reason}`}>
											{entry.alias} — {skipReasonLabel(entry.reason)}
										</li>
									))}
								</ul>
							</details>
						) : null}
						{scanNote !== null ? <p className="px-1 text-label text-muted-foreground">{scanNote}</p> : null}
					</div>
				) : null}

				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1">
						<Label htmlFor="remote-host-label">{t("settings.connections.add.label")}</Label>
						<Input
							id="remote-host-label"
							value={form.label}
							onChange={(event) =>
								setForm((current) => ({
									...current,
									label: event.target.value,
								}))
							}
						/>
					</div>
					<div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
						<div className="flex min-w-0 flex-col gap-1">
							<Label htmlFor="remote-host-name">{t("settings.connections.add.hostName")}</Label>
							<Input
								id="remote-host-name"
								placeholder="host.com"
								value={form.hostName}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										hostName: event.target.value,
									}))
								}
							/>
						</div>
						<div className="flex min-w-0 flex-col gap-1">
							<Label htmlFor="remote-host-port">{t("settings.connections.add.port")}</Label>
							<Input
								id="remote-host-port"
								inputMode="numeric"
								placeholder="22"
								value={form.port}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										port: event.target.value,
									}))
								}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="remote-host-user">{t("settings.connections.add.user")}</Label>
						<Input id="remote-host-user" autoComplete="off" spellCheck={false} placeholder={t("settings.connections.add.userPlaceholder")} value={form.user} onChange={(event) => setForm((current) => ({ ...current, user: event.target.value }))} />
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-label text-muted-foreground">{t("settings.connections.add.authLabel")}</span>
						<div role="group" aria-label={t("settings.connections.add.authLabel")} className="flex w-fit overflow-hidden rounded-lg border border-input">
							<button
								type="button"
								aria-pressed={form.auth === "agent"}
								className={cn("inline-flex min-h-8 items-center px-3 text-body", form.auth === "agent" ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-bg-hover")}
								onClick={() =>
									setForm((current) => ({
										...current,
										auth: "agent",
										identityFile: "",
									}))
								}
							>
								{t("settings.connections.add.auth.agent")}
							</button>
							<button
								type="button"
								aria-pressed={form.auth === "key"}
								className={cn("inline-flex min-h-8 items-center border-l border-input px-3 text-body", form.auth === "key" ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-bg-hover")}
								onClick={() => setForm((current) => ({ ...current, auth: "key" }))}
							>
								{t("settings.connections.add.auth.key")}
							</button>
							<span title={t("settings.connections.add.auth.passwordUnsupported")} aria-disabled="true" className="inline-flex min-h-8 cursor-not-allowed items-center border-l border-input px-3 text-body text-muted-foreground opacity-50">
								{t("settings.connections.add.auth.password")}
							</span>
						</div>
					</div>
					{form.auth === "key" ? (
						<div className="flex flex-col gap-1">
							<Label htmlFor="remote-host-identity">{t("settings.connections.add.identityFile")}</Label>
							<Input
								id="remote-host-identity"
								autoComplete="off"
								spellCheck={false}
								placeholder={t("settings.connections.add.identityFilePlaceholder")}
								value={form.identityFile}
								onChange={(event) =>
									setForm((current) => ({
										...current,
										identityFile: event.target.value,
									}))
								}
							/>
						</div>
					) : null}
					<p className="text-label text-muted-foreground">{t("settings.connections.add.credentialsHint")}</p>
				</div>

				{error !== null ? <p className="text-label text-destructive">{error}</p> : null}

				<DialogFooter className="items-center justify-between gap-2 sm:justify-between">
					<span className="min-w-0 truncate text-label text-muted-foreground">{importing ? t("settings.connections.add.importHint") : null}</span>
					<div className="flex items-center gap-2">
						<Button variant="ghost" onClick={props.onClose}>
							{t("common.cancel")}
						</Button>
						<Button disabled={busy} onClick={() => void submit()}>
							{t("settings.connections.add.submitConnect")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

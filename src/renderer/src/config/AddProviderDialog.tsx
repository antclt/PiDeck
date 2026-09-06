import { useEffect, useState } from "react";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { t } from "../i18n";
import { isValidProviderName } from "../../../shared/providerName";
import { ApiTypeInput, ConfigSelect, SecretInput } from "./ConfigShared";
import { CUSTOM_USER_AGENT_VALUE, getUserAgentOptions } from "./providerHeaders";
import type { AddProviderDraft } from "./addProviderDraft";

/**
 * 新增供应商弹窗（Pi 模型页）：点「+ 添加供应商」直接弹出完整表单，
 * 字段与展开卡片一致（名字 / Base URL / API 类型 / API Key / User-Agent / 兼容性），
 * 填完点「添加」一步加入，不再需要先输名字再展开卡片。
 * 草稿类型与转换逻辑见 addProviderDraft.ts（纯函数可单测）。
 */

export function AddProviderDialog(props: {
	open: boolean;
	/** 已存在的供应商名（防重名；重名时确定按钮禁用并提示）。 */
	existingNames: string[];
	onClose: () => void;
	onConfirm: (draft: AddProviderDraft) => void;
}) {
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [userAgent, setUserAgent] = useState("");
	const [compat, setCompat] = useState({
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	});

	// 每次打开重置草稿（新供应商），避免上次输入残留
	useEffect(() => {
		if (props.open) {
			setName("");
			setBaseUrl("");
			setApi("");
			setApiKey("");
			setUserAgent("");
			setCompat({ supportsDeveloperRole: false, supportsReasoningEffort: false });
		}
	}, [props.open]);

	const trimmedName = name.trim();
	const nameValid = isValidProviderName(trimmedName);
	const duplicate = trimmedName !== "" && props.existingNames.includes(trimmedName);
	const canConfirm = nameValid && !duplicate;

	const submit = () => {
		if (!canConfirm) return;
		props.onConfirm({
			name: trimmedName,
			baseUrl: baseUrl.trim(),
			api,
			apiKey: apiKey.trim(),
			userAgent: userAgent.trim(),
			compat,
		});
	};

	const userAgentOptions = getUserAgentOptions();
	const userAgentSelectValue = userAgentOptions.some(
		(option) => option.value === userAgent,
	)
		? userAgent
		: CUSTOM_USER_AGENT_VALUE;

	return (
		<Dialog open={props.open} onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("config.addProviderDialogTitle")}</DialogTitle>
				</DialogHeader>
				<div className="config-provider-form grid gap-2.5">
					<div className="grid grid-cols-[90px_1fr] items-start gap-2.5">
						<Label className="pl-0.5 pt-1.5 text-left text-xs font-medium text-text-secondary">
							{t("config.addProviderName")}
						</Label>
						<div className="flex min-w-0 flex-col gap-1">
							<Input
								value={name}
								className="h-8 min-w-0 rounded-sm border border-border-subtle bg-bg-panel px-3 font-mono text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
								placeholder={t("config.providerNamePlaceholder")}
								autoFocus
								onChange={(e) => setName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") submit();
								}}
							/>
							{trimmedName !== "" && !nameValid && (
								<span className="text-[11px] leading-relaxed text-destructive">{t("config.providerNameRule")}</span>
							)}
							{duplicate && (
								<span className="text-[11px] leading-relaxed text-destructive">{t("config.providerNameDuplicate")}</span>
							)}
						</div>
					</div>
					<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
						<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.baseUrl")}</Label>
						<div className="config-base-url-field">
							<Input
								value={baseUrl}
								className="h-8 min-w-0 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
								onChange={(e) => setBaseUrl(e.target.value)}
								placeholder="https://api.openai.com/v1"
							/>
							<span className="mt-1 block text-[11px] leading-relaxed text-text-tertiary">{t("config.baseUrlHint")}</span>
						</div>
					</div>
					<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
						<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiType")}</Label>
						<ApiTypeInput value={api} onChange={setApi} />
					</div>
					<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
						<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiKey")}</Label>
						<SecretInput value={apiKey} onChange={setApiKey} />
					</div>
					<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
						<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.userAgent")}</Label>
						<div className="config-header-field">
							<ConfigSelect
								value={userAgentSelectValue}
								options={[
									...userAgentOptions,
									{ value: CUSTOM_USER_AGENT_VALUE, label: t("config.custom") },
								]}
								onChange={(value) => {
									if (value === CUSTOM_USER_AGENT_VALUE) return;
									setUserAgent(value);
								}}
							/>
							<Input
								value={userAgent}
								onChange={(e) => setUserAgent(e.target.value)}
								placeholder={t("common.notConfigured")}
							/>
							<span>{t("config.headerEmptyHint")}</span>
						</div>
					</div>
					<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
						<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.compatibility")}</Label>
						<div className="config-compat-group">
							<div className="config-compat-item">
								<Label className="config-checkbox-label">
									<Checkbox
										checked={compat.supportsDeveloperRole}
										onCheckedChange={(checked) =>
											setCompat((prev) => ({ ...prev, supportsDeveloperRole: checked === true }))
										}
									/>
									<span>{t("config.developerRole")}</span>
								</Label>
								<small className="config-compat-item-desc">{t("config.developerRoleDesc")}</small>
							</div>
							<div className="config-compat-item">
								<Label className="config-checkbox-label">
									<Checkbox
										checked={compat.supportsReasoningEffort}
										onCheckedChange={(checked) =>
											setCompat((prev) => ({ ...prev, supportsReasoningEffort: checked === true }))
										}
									/>
									<span>{t("config.reasoningEffort")}</span>
								</Label>
								<small className="config-compat-item-desc">{t("config.reasoningEffortDesc")}</small>
							</div>
						</div>
					</div>
				</div>
				<DialogFooter>
					<Button type="button" variant="outline" size="sm" onClick={props.onClose}>
						{t("common.cancel")}
					</Button>
					<Button type="button" variant="default" size="sm" disabled={!canConfirm} onClick={submit}>
						{t("config.addProviderConfirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

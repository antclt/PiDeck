/** pi ↔ DSH 单供应商配置互迁契约（不含密钥明文）。 */

export type ProviderMigrationDirection = "pi-to-dsh" | "dsh-to-pi";

export type MigratableProviderRow = {
	name: string;
	modelCount: number;
	hasKey: boolean;
	baseUrl?: string;
	namespace?: "llm-pi-ai" | "llm-deepseek";
	targetExists: boolean;
};

export type ProviderMigrationPreview = {
	direction: ProviderMigrationDirection;
	providers: MigratableProviderRow[];
};

export type ProviderMigrationResult = {
	ok: boolean;
	provider: string;
	direction: ProviderMigrationDirection;
	copiedKey: boolean;
	wroteViaHost: boolean;
	error?: string;
};

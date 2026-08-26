/** DSH host llm.discoverModels request passed across the IPC boundary. */
export type DshModelDiscoveryInput = {
	/** DSH settings namespace that owns the provider adapter. */
	settingsNs: string;
	/** Provider route currently being edited; omit for a new/unregistered route. */
	provider?: string;
	/** Draft endpoint/protocol values. */
	baseURL?: string;
	api?: string;
	/** One-shot draft credential; DSH never stores or returns it. */
	apiKey?: string;
};

/** Candidate model metadata returned by DSH llm.discoverModels. */
export type DshDiscoveredModel = {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
};

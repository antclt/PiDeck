import { AsyncLocalStorage } from "node:async_hooks";

export type WslGitIdentity = { distro: string; user: string };

// The Git services are shared by projects, so identity must follow each async operation, not the service instance.
const identityContext = new AsyncLocalStorage<WslGitIdentity | undefined>();

export function withWslGitIdentity<T>(identity: WslGitIdentity | undefined, work: () => T): T {
	return identityContext.run(identity, work);
}

export function currentWslGitIdentity(): WslGitIdentity | undefined {
	return identityContext.getStore();
}

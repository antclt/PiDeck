/**
 * 远端事实变化通知（v5 T4「通知闭环」）。
 *
 * 分工写死在这里，避免退化成“事件即装载”：
 * - **生产者**（helper `fs.watch` 事件、写面完成、unknown 写）只调用 `publish`；
 * - **主进程事实层只标脏**，不因为一次事件去读远端；
 * - **渲染层**按 `(projectId)` 订阅，收到通知后由活跃的读者决定何时重读；退订/隐藏/关闭就不再有读者。
 *
 * 订阅绑定 sender：同一窗口订阅了项目 A，就不能收到项目 B 的通知；窗口销毁时登记一并清掉，
 * 不会把事件发给一个已销毁的 webContents。`generation` 随通知一起过去，渲染层跨代丢弃缓存。
 */
import type { RemoteProjectFactsChange } from "../../shared/types/remoteHost";

/** 能接收推送的最小 webContents 形状（测试用同构的假对象）。 */
export type RemoteFactsSubscriber = {
	readonly id: number;
	send(channel: string, payload: unknown): void;
	once(event: "destroyed", listener: () => void): void;
	removeListener(event: "destroyed", listener: () => void): void;
};

export type RemoteFactsHub = {
	/** 订阅一个项目（幂等）。sender 必须是活的 webContents。 */
	subscribe(subscriber: RemoteFactsSubscriber, projectId: string): void;
	/** 退订一个项目（不影响该 sender 的其它项目）。 */
	unsubscribe(senderId: number, projectId: string): void;
	/** 窗口销毁：清掉它的全部订阅。 */
	unsubscribeSender(senderId: number): void;
	/** 发布一次事实变化：只发给订阅了这个项目的 sender；没人订阅时什么都不做。 */
	publish(change: RemoteProjectFactsChange): void;
	/** 诊断/测试：某个项目当前有几个订阅者。 */
	subscriberCount(projectId: string): number;
};

export type RemoteFactsHubOptions = {
	/** 每个窗口最多同时订阅几个项目（防止渲染层泄漏订阅把登记表撑大）。 */
	maxProjectsPerSender?: number;
};

const PROJECT_ID = /^[\x21-\x7e][\x20-\x7e]{0,255}$/;
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;

function validProjectId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 256 && !CONTROL_BYTES.test(value) && value === value.trim() && value.length > 0;
}

export function createRemoteFactsHub(channel: string, options: RemoteFactsHubOptions = {}): RemoteFactsHub {
	const maxProjects = Math.max(1, Math.trunc(options.maxProjectsPerSender ?? 8));
	/** senderId → 它的订阅对象与项目集合。 */
	const senders = new Map<number, { subscriber: RemoteFactsSubscriber; projects: Set<string> }>();
	/** projectId → 订阅它的 senderId。 */
	const byProject = new Map<string, Set<number>>();

	function removeProject(senderId: number, projectId: string): void {
		const entry = senders.get(senderId);
		entry?.projects.delete(projectId);
		const subscribers = byProject.get(projectId);
		if (subscribers !== undefined) {
			subscribers.delete(senderId);
			if (subscribers.size === 0) byProject.delete(projectId);
		}
	}

	return {
		subscribe(subscriber, projectId) {
			if (!validProjectId(projectId) || !Number.isSafeInteger(subscriber.id) || subscriber.id < 1) return;
			let entry = senders.get(subscriber.id);
			if (entry === undefined) {
				const created = { subscriber, projects: new Set<string>() };
				const destroy = () => {
					// 窗口销毁：登记必须一起消失，否则下一次 publish 会往一个死掉的 webContents 发送。
					const current = senders.get(subscriber.id);
					if (current === undefined) return;
					for (const project of [...current.projects]) removeProject(subscriber.id, project);
					senders.delete(subscriber.id);
				};
				subscriber.once("destroyed", destroy);
				senders.set(subscriber.id, created);
				entry = created;
			}
			if (entry.projects.has(projectId)) return;
			if (entry.projects.size >= maxProjects) return;
			entry.projects.add(projectId);
			const subscribers = byProject.get(projectId) ?? new Set<number>();
			subscribers.add(subscriber.id);
			byProject.set(projectId, subscribers);
		},
		unsubscribe(senderId, projectId) {
			removeProject(senderId, projectId);
			// 一个 sender 不再订阅任何项目时保留登记：它还有 destroyed 监听，下一次订阅读取会复用。
		},
		unsubscribeSender(senderId) {
			const entry = senders.get(senderId);
			if (entry === undefined) return;
			for (const project of [...entry.projects]) removeProject(senderId, project);
			senders.delete(senderId);
		},
		publish(change) {
			if (!validProjectId(change.projectId) || !Array.isArray(change.scopes) || change.scopes.length === 0) return;
			const subscribers = byProject.get(change.projectId);
			if (subscribers === undefined || subscribers.size === 0) return;
			for (const senderId of [...subscribers]) {
				const entry = senders.get(senderId);
				if (entry === undefined) {
					subscribers.delete(senderId);
					continue;
				}
				try {
					// 一次事件一个载荷：同一个窗口不会因为订阅了多次而收到重复通知。
					entry.subscriber.send(channel, { projectId: change.projectId, generation: change.generation, scopes: change.scopes.map((scope) => ({ ...scope })) });
				} catch {
					// 观察者不是事务的一部分：通知失败不能把已经生效的写/失效说成失败。
				}
			}
		},
		subscriberCount: (projectId) => byProject.get(projectId)?.size ?? 0,
	};
}

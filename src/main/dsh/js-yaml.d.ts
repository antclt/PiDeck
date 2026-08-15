/**
 * js-yaml 模块声明（第三方包无内置类型；仅声明本应用使用到的 load）。
 * 用途：主进程读取 DSH 凭证文档（$DSH_HOME/.credentials.yaml，严格 ref→value 映射）。
 */
declare module "js-yaml" {
	export function load(text: string): unknown;
}

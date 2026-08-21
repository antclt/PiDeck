import { atom } from "jotai";
import { EMPTY_IMAGE_GEN_CONFIG, type ImageGenConfigFile } from "../../../shared/imageGenConfig";

/**
 * 独立生图配置快照。App 启动与配置页保存后写入；
 * composer 生图模式只读这份，不订阅会话 LLM 模型。
 */
export const imageGenConfigAtom = atom<ImageGenConfigFile>(EMPTY_IMAGE_GEN_CONFIG);

import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { FloatingController } from "../floating/FloatingController";

export function registerFloatingIpc(controller: FloatingController): void {
	ipcMain.handle(ipcChannels.floatingBallGetState, () => controller.getState());
	ipcMain.handle(ipcChannels.floatingBallEnter, () => controller.enter());
	ipcMain.handle(ipcChannels.floatingBallExit, () => controller.exit());
}

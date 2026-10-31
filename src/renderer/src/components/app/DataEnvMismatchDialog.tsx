import { useAtomValue, useSetAtom } from "jotai";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { dataEnvMismatchAtom } from "../../atoms/dataEnvAtoms";
import { buttonVariants } from "../ui-shadcn/button";
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui-shadcn/alert-dialog";

/**
 * 数据目录标记警告（规格 §6：stable 包落在 channel-dev 目录 → mismatch）。
 * 主进程 did-finish-load 后推送一次；「继续使用」放行本会话，「退出」交给主进程退出应用。
 * Esc/遮罩关闭不采纳任何选项：两键都是显式风险动作，静默关闭只会让状态悬挂，
 * 因此关闭手势直接忽略（onOpenChange 里不处理），必须二选一。
 */
export function DataEnvMismatchDialog() {
	const mismatch = useAtomValue(dataEnvMismatchAtom);
	const setMismatch = useSetAtom(dataEnvMismatchAtom);
	if (!mismatch) return null;

	return (
		<AlertDialog open onOpenChange={() => undefined}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("dataMode.mismatchTitle")}</AlertDialogTitle>
					<AlertDialogDescription>{t("dataMode.mismatchDesc")}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogAction
						onClick={() => {
							setMismatch(null);
							void desktopApi.dataEnv.confirmMismatch("continue");
						}}
					>
						{t("dataMode.mismatchContinue")}
					</AlertDialogAction>
					<AlertDialogAction
						className={buttonVariants({ variant: "destructive" })}
						onClick={() => {
							setMismatch(null);
							void desktopApi.dataEnv.confirmMismatch("quit");
						}}
					>
						{t("dataMode.mismatchQuit")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

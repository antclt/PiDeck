import { useEffect } from "react";
import { ScratchPadPanel } from "../scratchPad/ScratchPadPanel";
import type { useScratchPad } from "../../hooks/useScratchPad";

export type ScratchPadOverlayController = ReturnType<typeof useScratchPad>;

export type ScratchPadOverlayProps = {
	controller: ScratchPadOverlayController;
};

/** Owns the document-level shortcut and closing animation boundary for ScratchPad. */
export function ScratchPadOverlay({ controller }: ScratchPadOverlayProps) {
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			const shortcut = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "s";
			if (shortcut) {
				event.preventDefault();
				controller.toggle();
				return;
			}
			if (event.key === "Escape" && controller.isOpen) {
				event.stopPropagation();
				controller.close();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [controller]);

	if (!controller.isOpen && !controller.isClosing) return null;
	return (
		<div className={`scratch-pad-overlay${controller.isClosing ? " closing" : ""}`}>
			<ScratchPadPanel
				drafts={controller.drafts}
				currentDraftPath={controller.currentDraftPath}
				content={controller.content}
				mode={controller.mode}
				isClosing={controller.isClosing}
				isSaving={controller.isSaving}
				hasError={controller.hasError}
				onChangeContent={controller.setContent}
				onSetMode={controller.setMode}
				onToggleCheckbox={controller.toggleTaskCheckbox}
				onExport={() => void controller.exportFile()}
				onSelectDraft={(path) => void controller.selectDraft(path)}
				onCreateDraft={() => void controller.createDraft()}
				onDeleteDraft={(path) => void controller.deleteDraft(path)}
				onClose={controller.close}
			/>
		</div>
	);
}

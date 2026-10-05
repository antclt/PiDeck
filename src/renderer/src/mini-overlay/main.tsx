import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MiniOverlayApp } from "./MiniOverlayApp";

const root = createRoot(document.getElementById("root")!);
root.render(
	<StrictMode>
		<MiniOverlayApp />
	</StrictMode>,
);

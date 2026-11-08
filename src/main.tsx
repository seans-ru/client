import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { PipWindow } from "./features/player/extensions/PipWindow";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PIP_LABEL } from "./features/player/extensions/pipProtocol";
import "./design/tokens.css";
import "./design/primitives.css";
import "./design/app.css";
import { applyTheme, getTheme } from "./design/theme";

// Apply the stored preference before first paint to avoid a theme flash.
applyTheme(getTheme());

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root not found");
}

createRoot(rootEl).render(
  <StrictMode>
    {isTauri() && getCurrentWebviewWindow().label === PIP_LABEL ? <PipWindow /> : <App />}
  </StrictMode>,
);

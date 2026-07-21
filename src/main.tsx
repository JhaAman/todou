import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { QuickEntry } from "./features/quick-entry/QuickEntry";
import { loadPreferences } from "./lib/preferences";
import { resolveWindowKind } from "./lib/taskClient";
import { applyTheme } from "./lib/themes";
import "./styles.css";

async function start() {
  applyTheme(loadPreferences().themeId);
  const windowKind = await resolveWindowKind();
  document.body.dataset.window = windowKind;
  const root = document.getElementById("root");
  if (!root) throw new Error("Todou root element is missing");
  createRoot(root).render(
    <StrictMode>
      {windowKind === "quick-entry" ? <QuickEntry /> : <App />}
    </StrictMode>,
  );
}

void start();

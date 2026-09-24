import React from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider } from "@fluentui/react-components";
import { epflLightTheme } from "../theme/epflTheme";
import { App } from "./App";
import { hydrateSettings } from "../services/settingsStore";

/* global Office */

Office.onReady(async () => {
  // Recopie les réglages durables (clé API RCP…) dans localStorage avant le
  // premier rendu : sur desktop le localStorage peut être vide au redémarrage.
  await hydrateSettings();
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <FluentProvider theme={epflLightTheme} style={{ height: "100%" }}>
      <App />
    </FluentProvider>
  );
});

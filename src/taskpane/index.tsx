import React from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider } from "@fluentui/react-components";
import { epflLightTheme } from "../theme/epflTheme";
import { App } from "./App";

/* global Office */

Office.onReady(() => {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <FluentProvider theme={epflLightTheme} style={{ height: "100%" }}>
      <App />
    </FluentProvider>
  );
});

import React from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { TestApp } from "./TestApp";

// No Office.js dependency — render immediately
const root = createRoot(document.getElementById("root")!);
root.render(
  <FluentProvider theme={webLightTheme}>
    <TestApp />
  </FluentProvider>
);

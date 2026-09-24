import React from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider } from "@fluentui/react-components";
import { epflLightTheme } from "../theme/epflTheme";
import { TestApp } from "./TestApp";

// No Office.js dependency — render immediately
const root = createRoot(document.getElementById("root")!);
root.render(
  <FluentProvider theme={epflLightTheme}>
    <TestApp />
  </FluentProvider>
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "raft-ui";
import { DashboardApp } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");

if (!root) throw new Error("Missing application root.");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider defaultTheme="elegant" defaultMode="light">
      <DashboardApp />
    </ThemeProvider>
  </StrictMode>
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bindSystemThemeWatcher } from "./store/theme";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element in index.html");

bindSystemThemeWatcher();

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);

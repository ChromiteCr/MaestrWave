import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, readTheme } from "./lib/theme";
import "./styles/global.css";

// 渲染之前就把主题挂上，否则浅色用户会先闪一帧深色底
applyTheme(readTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

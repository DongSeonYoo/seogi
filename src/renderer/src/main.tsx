/// <reference types="vite/client" />
import "pretendard/dist/web/variable/pretendardvariable.css";
import { createRoot } from "react-dom/client";
import type { Api } from "../../shared/types";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/app.css";

declare global {
  interface Window {
    api: Api;
  }
}

createRoot(document.getElementById("root")!).render(<App />);

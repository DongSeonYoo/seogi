/// <reference types="vite/client" />
import { createRoot } from "react-dom/client";
import type { Api } from "../../shared/types";
import { I18nProvider } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/app.css";

declare global {
  interface Window {
    api: Api;
  }
}

const View = location.hash === "#settings"
  ? (await import("./SettingsView")).SettingsView
  : (await import("./App")).App;
createRoot(document.getElementById("root")!).render(
  <I18nProvider><View /></I18nProvider>,
);

/// <reference types="vite/client" />
import { createRoot } from "react-dom/client";
import type { Api } from "../../shared/types";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { SettingsView } from "./SettingsView";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/app.css";

declare global {
  interface Window {
    api: Api;
  }
}

// One renderer bundle, two windows: the settings window loads it with #settings.
createRoot(document.getElementById("root")!).render(
  <I18nProvider>{location.hash === "#settings" ? <SettingsView /> : <App />}</I18nProvider>,
);

import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { Translate } from "../shared/i18n";
import type { ActionId } from "../shared/types";
import type { History } from "./library";

/**
 * The menu bar. Commands are sent to the focused window as action ids; the renderer runs them
 * with the same code as the toolbar, context menus and ⌘K. Edit keeps the standard roles so
 * cut, copy, paste and select-all work in every field.
 */
export function appMenu(
  history: History,
  send: (id: ActionId) => void,
  openSettings: () => void,
  t: Translate,
  /** Commands the main window cannot run right now; greyed out here as they are on screen. */
  disabled: ReadonlySet<string> = new Set(),
  /** Labels the screen words by state (Star / Unstar), so the menu says the same. */
  labels: Record<string, string> = {},
): Menu {
  const item = (id: ActionId, label: string, accelerator?: string): MenuItemConstructorOptions => ({
    label: labels[id] ?? label,
    accelerator,
    enabled: !disabled.has(id),
    click: () => send(id),
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about", label: t("menu.about") },
        { type: "separator" },
        { label: t("menu.settings"), accelerator: "Cmd+,", click: openSettings },
        { type: "separator" },
        { role: "services", label: t("menu.services") },
        { type: "separator" },
        { role: "hide", label: t("menu.hide") },
        { role: "hideOthers", label: t("menu.hideOthers") },
        { role: "unhide", label: t("menu.showAll") },
        { type: "separator" },
        { role: "quit", label: t("menu.quit") },
      ],
    },
    {
      label: t("menu.file"),
      submenu: [
        item("newSession", t("action.newSession"), "Cmd+N"),
        item("record", t("menu.recordToggle"), "Cmd+Shift+R"),
        item("newFolder", t("action.newFolder"), "Cmd+Shift+N"),
        { type: "separator" },
        item("exportMarkdown", `${t("action.exportMarkdown")}…`, "Cmd+Shift+E"),
        item("exportText", `${t("action.exportText")}…`),
        { type: "separator" },
        { role: "close", label: t("menu.closeWindow") },
      ],
    },
    {
      label: t("menu.edit"),
      submenu: [
        // With a library change to undo, the renderer undoes typing in a text field and the change
        // elsewhere. With none, the native roles undo typing and grey out when there is nothing to do.
        history.undoLabel(t)
          ? item("undo", t("action.undoWhat", { what: history.undoLabel(t)! }), "Cmd+Z")
          : { role: "undo", label: t("action.undo") },
        history.redoLabel(t)
          ? item("redo", t("action.redoWhat", { what: history.redoLabel(t)! }), "Cmd+Shift+Z")
          : { role: "redo", label: t("action.redo") },
        { type: "separator" },
        { role: "cut", label: t("menu.cut") },
        { role: "copy", label: t("menu.copy") },
        { role: "paste", label: t("menu.paste") },
        { role: "selectAll", label: t("menu.selectAll") },
        { type: "separator" },
        item("find", `${t("action.find")}…`, "Cmd+F"),
        item("palette", `${t("action.palette")}…`, "Cmd+K"),
      ],
    },
    {
      label: t("menu.meeting"),
      submenu: [
        item("rename", t("action.rename")),
        item("star", t("action.star"), "Cmd+D"),
        item("summarize", t("action.summarize"), "Cmd+Shift+S"),
        { type: "separator" },
        item("delete", t("action.delete"), "Cmd+Backspace"),
      ],
    },
    {
      label: t("menu.view"),
      submenu: [
        item("toggleSidebar", t("action.toggleSidebar"), "Cmd+B"),
        item("toggleSummary", t("action.toggleSummary"), "Alt+Cmd+S"),
        { type: "separator" },
        // Reload and dev tools in any unpackaged run; the style guide only with the dev server
        // (`pnpm dev`), whose renderer is the only one that contains it.
        ...(app.isPackaged
          ? []
          : ([{ role: "reload" }, { role: "toggleDevTools" }, ...(process.env.ELECTRON_RENDERER_URL ? [item("styleGuide", t("action.styleGuide"), "Cmd+Shift+D")] : [])] as MenuItemConstructorOptions[])),
        { role: "togglefullscreen", label: t("menu.fullScreen") },
      ],
    },
    { role: "windowMenu", label: t("menu.window") },
  ];
  return Menu.buildFromTemplate(template);
}

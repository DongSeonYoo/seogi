import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { Translate } from "../shared/i18n";
import type { ActionId } from "../shared/types";
import type { History } from "./library";

/**
 * The menu bar. Commands are sent to the focused window as action ids; the renderer runs them
 * with the same code as the toolbar, context menus and ⌘K. Edit keeps the standard roles so
 * cut, copy, paste and select-all work in every field.
 */
export function appMenu(history: History, send: (id: ActionId) => void, openSettings: () => void, t: Translate): Menu {
  const item = (id: ActionId, label: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
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
        item("record", t("menu.recordToggle"), "Cmd+Shift+R"),
        item("newFolder", t("action.newFolder"), "Cmd+Shift+N"),
        { type: "separator" },
        { role: "close", label: t("menu.closeWindow") },
      ],
    },
    {
      label: t("menu.edit"),
      submenu: [
        // Not role "undo": in a text field the renderer undoes typing, elsewhere the last library change.
        item("undo", history.undoLabel ? t("action.undoWhat", { what: history.undoLabel }) : t("action.undo"), "Cmd+Z"),
        item("redo", history.redoLabel ? t("action.redoWhat", { what: history.redoLabel }) : t("action.redo"), "Cmd+Shift+Z"),
        { type: "separator" },
        { role: "cut", label: t("menu.cut") },
        { role: "copy", label: t("menu.copy") },
        { role: "paste", label: t("menu.paste") },
        { role: "selectAll", label: t("menu.selectAll") },
        { type: "separator" },
        item("palette", `${t("action.palette")}…`, "Cmd+K"),
      ],
    },
    {
      label: t("menu.meeting"),
      submenu: [
        item("rename", t("action.rename")),
        item("star", t("action.star"), "Cmd+D"),
        item("resummarize", t("action.resummarize"), "Cmd+Shift+S"),
        { type: "separator" },
        item("delete", t("action.delete"), "Cmd+Backspace"),
      ],
    },
    {
      label: t("menu.view"),
      submenu: [
        item("tab:summary", t("detail.summary"), "Cmd+1"),
        item("tab:transcript", t("detail.transcript"), "Cmd+2"),
        { type: "separator" },
        item("toggleSidebar", t("action.toggleSidebar"), "Ctrl+Cmd+S"),
        { type: "separator" },
        ...(app.isPackaged
          ? []
          : ([{ role: "reload" }, { role: "toggleDevTools" }, item("styleGuide", t("action.styleGuide"), "Cmd+Shift+D")] as MenuItemConstructorOptions[])),
        { role: "togglefullscreen", label: t("menu.fullScreen") },
      ],
    },
    { role: "windowMenu", label: t("menu.window") },
  ];
  return Menu.buildFromTemplate(template);
}

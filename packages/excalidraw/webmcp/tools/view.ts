import { THEME } from "@excalidraw/common";

import { CaptureUpdateAction } from "@excalidraw/element";

import { actionClearCanvas } from "../../actions/actionCanvas";

import { runAction } from "../actions";
import { ToolError, getCurrentSceneVersion } from "../common";
import {
  readBoolean,
  readColor,
  readEnum,
  readIds,
  readString,
} from "../input";
import { resolveElements } from "../scene";
import { isListedElement } from "../serialize";

import type { AppState } from "../../types";
import type { ToolDefinition } from "../common";

const selectElements: ToolDefinition = {
  name: "select-elements",
  allowInViewMode: true,
  title: "Select elements",
  description:
    "Selects elements on the canvas so the user sees them highlighted, replacing the current selection (or adding to or removing from it). An empty list clears the selection. Groups are selected whole.",
  inputSchema: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
      mode: {
        type: "string",
        enum: ["replace", "add", "remove"],
        description: "default replace",
      },
    },
    required: ["ids"],
  },
  annotations: {},
  handler: (input, ctx) => {
    const { app } = ctx;
    const ids = readIds(input, "ids", { maxItems: 500 }) ?? [];
    const mode =
      readEnum(input, "mode", ["replace", "add", "remove"] as const) ??
      "replace";
    if (!Array.isArray(input.ids)) {
      throw new ToolError("invalid-input", '"ids" must be an array.');
    }

    // locked elements can't be selected by the editor either
    const targets = resolveElements(ctx, ids, { includeLocked: false });
    if (mode === "replace") {
      if (targets.length) {
        app.selection.select(targets);
      } else {
        app.selection.clear();
      }
    } else if (mode === "add") {
      app.selection.add(targets);
    } else {
      app.selection.remove(targets);
    }
    return {};
  },
};

const focusViewport: ToolDefinition = {
  name: "focus-viewport",
  allowInViewMode: true,
  title: "Focus viewport",
  description:
    "Scrolls and zooms the view to show given elements, or the whole drawing when no ids are given, so the user can see them. Use after adding or changing something off-screen.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "elements to bring into view; default is everything",
      },
      fit: {
        type: "string",
        enum: ["scale-down", "contain", "none"],
        description:
          "scale-down: zoom out to fit, never in past 100% (default); contain: fill the view; none: only centre",
      },
    },
  },
  annotations: {},
  handler: (input, ctx) => {
    const { app } = ctx;
    const ids = readIds(input, "ids");
    const fit =
      readEnum(input, "fit", ["scale-down", "contain", "none"] as const) ??
      "scale-down";
    const targets = ids
      ? resolveElements(ctx, ids, { includeLocked: true })
      : app.scene.getNonDeletedElements();
    if (!targets.length) {
      throw new ToolError("not-found", "There is nothing to focus on.");
    }
    app.viewport.setViewport({
      target: targets,
      fit,
      animation: true,
      offsets: { ui: true },
    });
    return {};
  },
};

const configureCanvas: ToolDefinition = {
  name: "configure-canvas",
  title: "Configure canvas",
  description:
    "Changes how the canvas looks: light or dark theme, background color, grid, zen mode (hides the UI chrome), and the drawing's name. Only the given settings change.",
  inputSchema: {
    type: "object",
    properties: {
      theme: { type: "string", enum: ["light", "dark"] },
      backgroundColor: {
        type: "string",
        description: 'canvas color, e.g. "#ffffff"',
      },
      grid: { type: "boolean", description: "show the grid" },
      zenMode: { type: "boolean", description: "hide the editor UI" },
      name: { type: "string", description: "the drawing's name" },
    },
  },
  annotations: {},
  handler: (input, ctx) => {
    const { app } = ctx;
    const theme = readEnum(input, "theme", [THEME.LIGHT, THEME.DARK] as const);
    const backgroundColor = readColor(input, "backgroundColor");
    const grid = readBoolean(input, "grid");
    const zenMode = readBoolean(input, "zenMode");
    const name = readString(input, "name", { maxLength: 200 });

    const appState = {
      ...(theme ? { theme } : {}),
      ...(backgroundColor ? { viewBackgroundColor: backgroundColor } : {}),
      ...(grid !== undefined ? { gridModeEnabled: grid } : {}),
      ...(zenMode !== undefined ? { zenModeEnabled: zenMode } : {}),
      ...(name !== undefined ? { name } : {}),
    };
    if (!Object.keys(appState).length) {
      throw new ToolError(
        "invalid-input",
        "Give at least one of theme, backgroundColor, grid, zenMode or name.",
      );
    }

    app.api.updateScene({
      appState: appState as Pick<AppState, keyof typeof appState>,
      captureUpdate: backgroundColor
        ? CaptureUpdateAction.IMMEDIATELY
        : CaptureUpdateAction.EVENTUALLY,
    });
    return {};
  },
};

const history = (kind: "undo" | "redo"): ToolDefinition => ({
  name: kind,
  title: kind === "undo" ? "Undo" : "Redo",
  description:
    kind === "undo"
      ? "Reverts the most recent change to the drawing, whether the user or a tool made it. Call repeatedly to step further back. Reports whether anything changed."
      : "Re-applies the change that undo last reverted. Possible until something else changes the drawing. Reports whether anything changed.",
  inputSchema: { type: "object", properties: {} },
  annotations: {},
  handler: (_input, { app }) => {
    const before = getCurrentSceneVersion(app);
    app.actionManager.executeAction(app.actionManager.actions[kind], "api");
    const changed = getCurrentSceneVersion(app) !== before;
    return {
      changed,
      ...(changed
        ? {}
        : {
            note:
              kind === "undo"
                ? "Nothing was undone: there is nothing left to undo, or the user is in the middle of editing."
                : "Nothing was redone: there is nothing to redo, or the user is in the middle of editing.",
          }),
    };
  },
});

const clearCanvas: ToolDefinition = {
  name: "clear-canvas",
  title: "Clear canvas",
  description:
    "Deletes everything on the canvas. Only for when the user asked to start over. Reversible with the undo tool.",
  inputSchema: { type: "object", properties: {} },
  annotations: { consequentialHint: true },
  handler: async (_input, ctx) => {
    const count = ctx.app.scene
      .getNonDeletedElements()
      .filter(isListedElement).length;
    if (!count) {
      throw new ToolError("invalid-input", "The canvas is already empty.");
    }
    await runAction(ctx, actionClearCanvas, [], {
      notApplicable: "Clearing the canvas isn't allowed here.",
    });
    return { deleted: count };
  },
};

export const viewTools = [
  selectElements,
  focusViewport,
  configureCanvas,
  history("undo"),
  history("redo"),
  clearCanvas,
];

import {
  getNonDeletedElements,
  isFrameLikeElement,
  newElementWith,
} from "@excalidraw/element";

import type { ExcalidrawFrameElement } from "@excalidraw/element/types";

import {
  actionAlignBottom,
  actionAlignHorizontallyCentered,
  actionAlignLeft,
  actionAlignRight,
  actionAlignTop,
  actionAlignVerticallyCentered,
} from "../../actions/actionAlign";
import {
  distributeHorizontally,
  distributeVertically,
} from "../../actions/actionDistribute";
import { wrapInFrame } from "../../actions/actionFrame";
import { actionGroup, actionUngroup } from "../../actions/actionGroup";
import {
  actionBringForward,
  actionBringToFront,
  actionSendBackward,
  actionSendToBack,
} from "../../actions/actionZindex";
import { getSelectionStateForElements } from "../../components/App.selection";

import { runAction } from "../actions";
import { ToolError } from "../common";
import { readEnum, readIds, readString } from "../input";
import { resolveElements, withoutFrameChildren } from "../scene";
import { serializeElement } from "../serialize";

import type { Action } from "../../actions/types";
import type { ToolDefinition } from "../common";

const ALIGNMENTS: Record<string, Action> = {
  left: actionAlignLeft,
  right: actionAlignRight,
  top: actionAlignTop,
  bottom: actionAlignBottom,
  "center-horizontally": actionAlignHorizontallyCentered,
  "center-vertically": actionAlignVerticallyCentered,
};

/** how many things move on their own: a group counts once, as in the editor */
const countMovables = (
  elements: readonly { id: string; groupIds: readonly string[] }[],
) =>
  new Set(elements.map((element) => element.groupIds.at(-1) ?? element.id))
    .size;

const IDS_SCHEMA = {
  type: "array",
  items: { type: "string" },
} as const;

const alignElements: ToolDefinition = {
  name: "align-elements",
  title: "Align elements",
  description:
    "Lines up two or more elements along their left, right, top or bottom edge, or on their shared horizontal or vertical centre line. Groups move as one. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      ids: IDS_SCHEMA,
      alignment: {
        type: "string",
        enum: Object.keys(ALIGNMENTS),
        description:
          "center-horizontally puts centres on one vertical line; center-vertically on one horizontal line",
      },
    },
    required: ["ids", "alignment"],
  },
  annotations: {},
  handler: async (input, ctx) => {
    const ids = readIds(input, "ids", { required: true })!;
    const alignment = readEnum(
      input,
      "alignment",
      Object.keys(ALIGNMENTS) as (keyof typeof ALIGNMENTS)[],
      { required: true },
    );
    const targets = withoutFrameChildren(resolveElements(ctx, ids));
    await runAction(ctx, ALIGNMENTS[alignment], targets, {
      notApplicable:
        "Alignment needs at least two elements (or groups) that aren't frames.",
    });
    return { aligned: targets.length, alignment };
  },
};

const distributeElementsTool: ToolDefinition = {
  name: "distribute-elements",
  title: "Distribute elements",
  description:
    "Spaces three or more elements evenly between the outermost two, horizontally or vertically. Groups move as one. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      ids: IDS_SCHEMA,
      axis: { type: "string", enum: ["horizontal", "vertical"] },
    },
    required: ["ids", "axis"],
  },
  annotations: {},
  handler: async (input, ctx) => {
    const ids = readIds(input, "ids", { required: true })!;
    const axis = readEnum(input, "axis", ["horizontal", "vertical"] as const, {
      required: true,
    });
    const targets = withoutFrameChildren(resolveElements(ctx, ids));
    // (the editor only offers this for three or more, without an action predicate)
    if (countMovables(targets) < 3 || targets.some(isFrameLikeElement)) {
      throw new ToolError(
        "invalid-input",
        "Distributing needs at least three elements (or groups) that aren't frames.",
      );
    }
    await runAction(
      ctx,
      axis === "horizontal" ? distributeHorizontally : distributeVertically,
      targets,
      { notApplicable: "These elements can't be distributed." },
    );
    return { distributed: targets.length, axis };
  },
};

const groupElements: ToolDefinition = {
  name: "group-elements",
  title: "Group elements",
  description:
    "Groups two or more elements so that they select, move and resize as one. Returns the group id. Undo with the undo tool, or break it up with ungroup-elements.",
  inputSchema: {
    type: "object",
    properties: { ids: IDS_SCHEMA },
    required: ["ids"],
  },
  annotations: {},
  handler: async (input, ctx) => {
    const ids = readIds(input, "ids", { required: true })!;
    const targets = resolveElements(ctx, ids);
    await runAction(ctx, actionGroup, targets, {
      notApplicable:
        "Grouping needs at least two elements that aren't already one group.",
    });
    const map = ctx.app.scene.getNonDeletedElementsMap();
    const groupId = map.get(targets[0].id)?.groupIds.at(-1);
    return { groupId, grouped: targets.length };
  },
};

const ungroupElements: ToolDefinition = {
  name: "ungroup-elements",
  title: "Ungroup elements",
  description:
    "Breaks the outermost group of the given elements back into individual elements. One undo step.",
  inputSchema: {
    type: "object",
    properties: { ids: IDS_SCHEMA },
    required: ["ids"],
  },
  annotations: {},
  handler: async (input, ctx) => {
    const ids = readIds(input, "ids", { required: true })!;
    const targets = resolveElements(ctx, ids);
    await runAction(ctx, actionUngroup, targets, {
      notApplicable: "None of these elements is in a group.",
    });
    return { ungrouped: targets.length };
  },
};

const Z_ORDER: Record<string, Action> = {
  "bring-to-front": actionBringToFront,
  "bring-forward": actionBringForward,
  "send-backward": actionSendBackward,
  "send-to-back": actionSendToBack,
};

const reorderElements: ToolDefinition = {
  name: "reorder-elements",
  title: "Reorder elements",
  description:
    "Changes the stacking order of elements: all the way to the front or back, or one step forward or backward. Use when one element hides another. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      ids: IDS_SCHEMA,
      order: { type: "string", enum: Object.keys(Z_ORDER) },
    },
    required: ["ids", "order"],
  },
  annotations: {},
  handler: async (input, ctx) => {
    const ids = readIds(input, "ids", { required: true })!;
    const order = readEnum(
      input,
      "order",
      Object.keys(Z_ORDER) as (keyof typeof Z_ORDER)[],
      { required: true },
    );
    const targets = resolveElements(ctx, ids);
    await runAction(ctx, Z_ORDER[order], targets, {
      notApplicable: "These elements can't be reordered.",
    });
    return { reordered: targets.length, order };
  },
};

const wrapInFrameTool: ToolDefinition = {
  name: "wrap-in-frame",
  title: "Wrap in frame",
  description:
    "Puts elements into a new frame sized around them, with an optional title. Frames organize a drawing into sections and clip their contents when exported. Returns the frame id. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      ids: IDS_SCHEMA,
      name: { type: "string", description: "frame title" },
    },
    required: ["ids"],
  },
  annotations: {},
  handler: (input, ctx) => {
    const { app } = ctx;
    const ids = readIds(input, "ids", { required: true })!;
    const name = readString(input, "name", { maxLength: 200 });
    const targets = resolveElements(ctx, ids);
    if (
      targets.some(
        (element) => element.type === "frame" || element.type === "magicframe",
      )
    ) {
      throw new ToolError(
        "invalid-input",
        "Frames can't be wrapped in another frame. Give the elements to put inside.",
      );
    }

    const elements = app.scene.getElementsIncludingDeleted();
    const known = new Set(elements.map((element) => element.id));
    const appState = {
      ...app.state,
      ...getSelectionStateForElements(
        targets,
        getNonDeletedElements(elements),
        app.state,
      ),
    };
    const result = wrapInFrame(elements, appState, targets, app);
    if (!result || !result.elements) {
      throw new ToolError("failed", "The editor declined the change.");
    }
    const frame = result.elements.find(
      (element) => !known.has(element.id) && element.type === "frame",
    );
    app.syncActionResult(
      frame && name
        ? {
            ...result,
            elements: result.elements.map((element) =>
              element.id === frame.id
                ? newElementWith(element as ExcalidrawFrameElement, { name })
                : element,
            ),
          }
        : result,
    );

    const map = app.scene.getNonDeletedElementsMap();
    return {
      frame: frame
        ? serializeElement(map.get(frame.id)!, map, "summary")
        : null,
    };
  },
};

export const arrangeTools = [
  alignElements,
  distributeElementsTool,
  groupElements,
  ungroupElements,
  reorderElements,
  wrapInFrameTool,
];

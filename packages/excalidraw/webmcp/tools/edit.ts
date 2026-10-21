import { getFontString, normalizeLink } from "@excalidraw/common";

import {
  computeContainerDimensionForBoundText,
  duplicateElements,
  getBoundTextElement,
  getBoundTextMaxWidth,
  getDefaultRoundnessTypeForElement,
  isArrowElement,
  isBindingElement,
  isFrameLikeElement,
  isLinearElement,
  isTextElement,
  measureText,
  newElementWith,
  newTextElement,
  normalizeText,
  redrawTextBoundingBox,
  syncMovedIndices,
  updateBoundElements,
} from "@excalidraw/element";

import { arrayToMap } from "@excalidraw/common";

import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawTextElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { actionDeleteSelected } from "../../actions/actionDeleteSelected";

import { runAction } from "../actions";
import { ToolError } from "../common";
import {
  readArray,
  readBoolean,
  readColor,
  readIds,
  readNumber,
  readRecord,
  readString,
} from "../input";
import { commitScene, resolveElements, revealElements } from "../scene";
import { serializeElement } from "../serialize";
import {
  STYLE_SCHEMA,
  TEXT_STYLE_SCHEMA,
  readStyle,
  readTextStyle,
} from "../style";

import type { ToolContext, ToolDefinition } from "../common";

const MAX_UPDATES_PER_CALL = 100;
const MAX_TEXT_LENGTH = 5000;
const MAX_COPIES = 10;
const ALLOWED_LINK_PROTOCOLS = /^(?:https?|mailto|tel):/i;

/** the targets with what travels with them: labels and frame children */
const withDependents = (
  { app }: ToolContext,
  targets: readonly NonDeletedExcalidrawElement[],
) =>
  app.scene.getSelectedElements({
    selectedElementIds: Object.fromEntries(targets.map((t) => [t.id, true])),
    includeBoundTextElement: true,
    includeElementsInFrames: true,
  });

/**
 * Moves the elements the way the arrow keys do: labels and frame children
 * go along, arrows bound to a shape keep following it, and an arrow attached
 * to something that stays put is left alone (moving it would detach it).
 * @returns the ids of the arrows that stayed
 */
const moveElementsBy = (
  ctx: ToolContext,
  targets: readonly NonDeletedExcalidrawElement[],
  dx: number,
  dy: number,
) => {
  const { app } = ctx;
  const all = withDependents(ctx, targets);
  const inSet = new Set(all.map((element) => element.id));

  const stayingArrows = new Set(
    all
      .filter((element): element is NonDeleted<ExcalidrawArrowElement> =>
        isBindingElement(element),
      )
      .filter(
        (arrow) =>
          (arrow.startBinding && !inSet.has(arrow.startBinding.elementId)) ||
          (arrow.endBinding && !inSet.has(arrow.endBinding.elementId)),
      )
      .map((arrow) => arrow.id),
  );

  const moving = all.filter((element) => !stayingArrows.has(element.id));
  for (const element of moving) {
    app.scene.mutateElement(
      element,
      { x: element.x + dx, y: element.y + dy },
      { informMutation: false, isDragging: false },
    );
    updateBoundElements(element, app.scene, { simultaneouslyUpdated: moving });
  }
  return [...stayingArrows];
};

const readLink = (input: Record<string, unknown>, path: string) => {
  if (input.link === null || input.link === "") {
    return null;
  }
  const link = readString(input, "link", { maxLength: 2000, path });
  if (link === undefined) {
    return undefined;
  }
  if (!ALLOWED_LINK_PROTOCOLS.test(link.trim())) {
    throw new ToolError(
      "invalid-input",
      `"${path}" must be an http(s), mailto or tel link, or null to remove it.`,
    );
  }
  return normalizeLink(link);
};

/**
 * Widens a shape so that its label fits on its lines, as typing into the
 * label would (a label wraps only at the width its shape already has).
 */
const widenContainerForLabel = (
  { app }: ToolContext,
  container: NonDeletedExcalidrawElement | null,
  label: ExcalidrawTextElement,
) => {
  if (!container || isArrowElement(container)) {
    return;
  }
  const naturalWidth = measureText(
    label.originalText,
    getFontString(label),
    label.lineHeight,
    app.renderEnvironment,
  ).width;
  if (naturalWidth > getBoundTextMaxWidth(container, label)) {
    app.scene.mutateElement(container, {
      width: Math.max(
        container.width,
        computeContainerDimensionForBoundText(naturalWidth, container.type),
      ),
    });
  }
};

type TextOwner = {
  container: NonDeletedExcalidrawElement | null;
  text: NonDeleted<ExcalidrawTextElement>;
};

/** the text element that an element's `text` refers to: itself, or its label */
const getTextOwner = (
  { app }: ToolContext,
  element: NonDeletedExcalidrawElement,
): TextOwner | null => {
  if (isTextElement(element)) {
    return {
      container: element.containerId
        ? app.scene.getNonDeletedElementsMap().get(element.containerId) ?? null
        : null,
      text: element,
    };
  }
  const label = getBoundTextElement(
    element,
    app.scene.getNonDeletedElementsMap(),
  );
  return label ? { container: element, text: label } : null;
};

const canHaveLabel = (element: ExcalidrawElement) =>
  !isTextElement(element) &&
  (isArrowElement(element) ||
    ["rectangle", "ellipse", "diamond", "stickynote"].includes(element.type));

/** gives a shape or arrow its first label */
const addLabel = (
  ctx: ToolContext,
  container: NonDeletedExcalidrawElement,
  text: string,
  style: ReturnType<typeof readTextStyle>,
  color: string | undefined,
) => {
  const { app } = ctx;
  const label = newTextElement({
    x: container.x,
    y: container.y,
    text,
    containerId: container.id,
    strokeColor: color ?? container.strokeColor,
    textAlign: style.textAlign ?? "center",
    verticalAlign: style.verticalAlign ?? "middle",
    ...(style.fontSize ? { fontSize: style.fontSize } : {}),
    ...(style.fontFamily ? { fontFamily: style.fontFamily } : {}),
    frameId: container.frameId,
    renderEnvironment: app.renderEnvironment,
  });
  app.scene.insertElement(label);
  app.scene.mutateElement(container, {
    boundElements: [
      ...(container.boundElements ?? []),
      { type: "text", id: label.id },
    ],
  });
  widenContainerForLabel(ctx, container, label);
  redrawTextBoundingBox(label, container, app.scene, app.renderEnvironment);
};

const UPDATE_PROPERTIES = {
  id: { type: "string", description: "element to change" },
  x: { type: "number", description: "new left edge (scene coordinates)" },
  y: { type: "number", description: "new top edge" },
  width: { type: "number", description: "shapes, frames and images only" },
  height: { type: "number", description: "shapes, frames and images only" },
  angle: { type: "number", description: "rotation in degrees" },
  text: {
    type: "string",
    description: "text of a text element, or the label of a shape or arrow",
  },
  textColor: { type: "string", description: "color of the label text" },
  name: { type: "string", description: "title of a frame" },
  link: { type: ["string", "null"], description: "http(s) link, null removes" },
  locked: { type: "boolean" },
  ...STYLE_SCHEMA,
  ...TEXT_STYLE_SCHEMA,
} as const;

const updateElements: ToolDefinition = {
  name: "update-elements",
  title: "Update elements",
  description:
    "Changes existing elements by id: position, size, rotation, colors and line style, text or label, font, frame name, link, lock. Only the given fields change. Frames carry their contents and arrows stay bound. One undo step for all updates.",
  inputSchema: {
    type: "object",
    properties: {
      updates: {
        type: "array",
        description: `up to ${MAX_UPDATES_PER_CALL} updates`,
        items: {
          type: "object",
          properties: UPDATE_PROPERTIES,
          required: ["id"],
        },
      },
    },
    required: ["updates"],
  },
  annotations: {},
  handler: (input, ctx) => {
    const { app } = ctx;
    const entries = readArray(input, "updates", {
      required: true,
      minItems: 1,
      maxItems: MAX_UPDATES_PER_CALL,
    });

    type Parsed = {
      id: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      angle?: number;
      text?: string;
      textColor?: string;
      name?: string;
      link?: string | null;
      locked?: boolean;
      style: ReturnType<typeof readStyle>;
      textStyle: ReturnType<typeof readTextStyle>;
    };

    const parsed: Parsed[] = entries.map((raw, index) => {
      const path = `updates[${index}]`;
      const entry = readRecord(raw, path);
      const id = readString(entry, "id", {
        required: true,
        path: `${path}.id`,
      });
      const next: Parsed = {
        id,
        x: readNumber(entry, "x", { path: `${path}.x` }),
        y: readNumber(entry, "y", { path: `${path}.y` }),
        width: readNumber(entry, "width", { min: 1, path: `${path}.width` }),
        height: readNumber(entry, "height", {
          min: 1,
          path: `${path}.height`,
        }),
        angle: readNumber(entry, "angle", { path: `${path}.angle` }),
        text: readString(entry, "text", {
          maxLength: MAX_TEXT_LENGTH,
          path: `${path}.text`,
        }),
        textColor: readColor(entry, "textColor", `${path}.textColor`),
        name: readString(entry, "name", {
          maxLength: 200,
          path: `${path}.name`,
        }),
        link: "link" in entry ? readLink(entry, `${path}.link`) : undefined,
        locked: readBoolean(entry, "locked", `${path}.locked`),
        style: readStyle(entry, `${path}.`),
        textStyle: readTextStyle(entry, `${path}.`),
      };
      const changes = Object.entries(next).filter(
        ([key, value]) =>
          key !== "id" &&
          value !== undefined &&
          !(typeof value === "object" && value && !Object.keys(value).length),
      );
      if (!changes.length) {
        throw new ToolError(
          "invalid-input",
          `"${path}" has nothing to change besides its id.`,
        );
      }
      return next;
    });

    const targets = resolveElements(
      ctx,
      parsed.map((update) => update.id),
      { includeLocked: true },
    );
    const byId = new Map(targets.map((element) => [element.id, element]));

    // validate everything up front so a bad entry changes nothing
    parsed.forEach((update, index) => {
      const path = `updates[${index}]`;
      const element = byId.get(update.id)!;
      if (element.locked && update.locked !== false) {
        throw new ToolError(
          "invalid-input",
          `Element "${element.id}" is locked. Unlock it first with { "id": "${element.id}", "locked": false }.`,
        );
      }
      if (
        (update.width !== undefined || update.height !== undefined) &&
        (isTextElement(element) ||
          isLinearElement(element) ||
          element.type === "freedraw" ||
          element.type === "stickynote")
      ) {
        throw new ToolError(
          "invalid-input",
          `"${path}": the size of a ${element.type} follows its content. Change fontSize for text, or points by re-creating lines and arrows.`,
        );
      }
      if (update.text !== undefined) {
        if (isFrameLikeElement(element)) {
          throw new ToolError(
            "invalid-input",
            `"${path}.text": a frame has a name, not text. Use "name".`,
          );
        }
        if (!getTextOwner(ctx, element) && !canHaveLabel(element)) {
          throw new ToolError(
            "invalid-input",
            `"${path}.text": a ${element.type} can't have a label. Add a separate text element instead.`,
          );
        }
        if (isTextElement(element) && element.containerId) {
          throw new ToolError(
            "invalid-input",
            `"${path}": "${element.id}" is a label; use the id of the shape or arrow it belongs to.`,
          );
        }
      }
      if (update.name !== undefined && !isFrameLikeElement(element)) {
        throw new ToolError(
          "invalid-input",
          `"${path}.name": only frames have a name.`,
        );
      }
    });

    app.store.scheduleCapture();

    const stayed: string[] = [];
    for (const update of parsed) {
      const element = byId.get(update.id)!;
      const { style, textStyle } = update;

      // move: by the difference, so that labels, arrows and frame contents go along
      if (update.x !== undefined || update.y !== undefined) {
        const dx = (update.x ?? element.x) - element.x;
        const dy = (update.y ?? element.y) - element.y;
        if (dx || dy) {
          stayed.push(...moveElementsBy(ctx, [element], dx, dy));
        }
      }

      const { roundness, ...visual } = style;
      const props: Record<string, unknown> = { ...visual };
      if (roundness) {
        props.roundness =
          roundness === "round"
            ? getDefaultRoundnessTypeForElement(element)
            : null;
      }
      if (update.width !== undefined) {
        props.width = update.width;
      }
      if (update.height !== undefined) {
        props.height = update.height;
      }
      if (update.angle !== undefined && !isArrowElement(element)) {
        props.angle = (update.angle * Math.PI) / 180;
      }
      if (update.name !== undefined) {
        props.name = update.name || null;
      }
      if (update.link !== undefined) {
        props.link = update.link;
      }
      if (update.locked !== undefined) {
        props.locked = update.locked;
      }

      // text style belongs to the text itself, or to the label of a shape
      const owner = getTextOwner(ctx, element);
      const textProps: Record<string, unknown> = { ...textStyle };
      if (update.textColor !== undefined) {
        textProps.strokeColor = update.textColor;
      }
      if (update.text !== undefined) {
        const text = normalizeText(update.text);
        textProps.originalText = text;
        textProps.text = text;
      }

      if (Object.keys(props).length) {
        app.scene.mutateElement(element, props as any);
      }

      if (owner && Object.keys(textProps).length) {
        app.scene.mutateElement(owner.text, textProps as any);
        widenContainerForLabel(ctx, owner.container, owner.text);
        redrawTextBoundingBox(
          owner.text,
          owner.container,
          app.scene,
          app.renderEnvironment,
        );
      } else if (!owner && update.text !== undefined && update.text) {
        addLabel(
          ctx,
          element,
          normalizeText(update.text),
          textStyle,
          update.textColor,
        );
      }

      // a resize or rotation moves the label and the arrows bound to it
      if (
        update.width !== undefined ||
        update.height !== undefined ||
        update.angle !== undefined
      ) {
        const label = getBoundTextElement(
          element,
          app.scene.getNonDeletedElementsMap(),
        );
        if (label) {
          redrawTextBoundingBox(
            label,
            element,
            app.scene,
            app.renderEnvironment,
          );
        }
        updateBoundElements(element, app.scene);
      }
    }

    app.scene.triggerUpdate();

    const map = app.scene.getNonDeletedElementsMap();
    return {
      updated: parsed.map((update) =>
        serializeElement(map.get(update.id)!, map, "summary"),
      ),
      ...(stayed.length
        ? {
            notMoved: [...new Set(stayed)],
            note: "These arrows are bound to elements that didn't move, so they stayed in place. Move the shapes they connect instead.",
          }
        : {}),
    };
  },
};

const moveElements: ToolDefinition = {
  name: "move-elements",
  title: "Move elements",
  description:
    "Shifts elements by an offset, keeping their relative layout. Labels and frame contents go along, and bound arrows follow. Use update-elements to set an absolute position. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
      dx: { type: "number", description: "right (+) or left (-)" },
      dy: { type: "number", description: "down (+) or up (-)" },
      reveal: {
        type: "boolean",
        description: "scroll the result into view if needed, default false",
      },
    },
    required: ["ids"],
  },
  annotations: {},
  handler: (input, ctx) => {
    const { app } = ctx;
    const ids = readIds(input, "ids", { required: true })!;
    const dx = readNumber(input, "dx") ?? 0;
    const dy = readNumber(input, "dy") ?? 0;
    if (!dx && !dy) {
      throw new ToolError("invalid-input", 'Give a non-zero "dx" or "dy".');
    }
    const targets = resolveElements(ctx, ids);

    app.store.scheduleCapture();
    const stayed = moveElementsBy(ctx, targets, dx, dy);
    app.scene.triggerUpdate();

    if (readBoolean(input, "reveal")) {
      revealElements(ctx, targets);
    }
    const map = app.scene.getNonDeletedElementsMap();
    return {
      moved: targets
        .filter((element) => !stayed.includes(element.id))
        .map((element) =>
          serializeElement(map.get(element.id)!, map, "summary"),
        ),
      ...(stayed.length ? { notMoved: stayed } : {}),
    };
  },
};

const deleteElements: ToolDefinition = {
  name: "delete-elements",
  title: "Delete elements",
  description:
    "Removes elements by id, with their labels (and a frame's contents are kept, only the frame goes). Arrows attached to them stay as loose arrows. Undoable with the undo tool.",
  inputSchema: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
    },
    required: ["ids"],
  },
  annotations: {},
  handler: async (input, ctx) => {
    const ids = readIds(input, "ids", { required: true })!;
    const targets = resolveElements(ctx, ids);
    await runAction(ctx, actionDeleteSelected, targets, {
      notApplicable: "These elements can't be deleted right now.",
    });
    return { deleted: targets.map((element) => element.id) };
  },
};

const duplicateElementsTool: ToolDefinition = {
  name: "duplicate-elements",
  title: "Duplicate elements",
  description:
    "Copies elements (with their labels, groups, frame contents and the arrows between them), shifted by an offset. Use count to lay out a row of copies. Returns the ids of the copies. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
      dx: { type: "number", description: "offset per copy, default 40" },
      dy: { type: "number", description: "offset per copy, default 40" },
      count: {
        type: "integer",
        description: `number of copies, default 1, max ${MAX_COPIES}`,
      },
    },
    required: ["ids"],
  },
  annotations: {},
  handler: (input, ctx) => {
    const { app } = ctx;
    const ids = readIds(input, "ids", { required: true })!;
    const dx = readNumber(input, "dx") ?? 40;
    const dy = readNumber(input, "dy") ?? 40;
    const count =
      readNumber(input, "count", { integer: true, min: 1, max: MAX_COPIES }) ??
      1;
    const originals = withDependents(ctx, resolveElements(ctx, ids));

    const added: ExcalidrawElement[] = [];
    const copiesOfTargets: string[][] = [];
    for (let copy = 1; copy <= count; copy++) {
      const duplicateIds = new Map<string, string>();
      const { duplicatedElements } = duplicateElements({
        type: "everything",
        elements: originals,
        randomizeSeed: true,
        overrides: ({ origElement, duplicateElement }) => {
          duplicateIds.set(origElement.id, duplicateElement.id);
          return {};
        },
      });
      added.push(
        ...duplicatedElements.map((element) =>
          newElementWith(element, {
            x: element.x + dx * copy,
            y: element.y + dy * copy,
          }),
        ),
      );
      copiesOfTargets.push(
        ids.flatMap((id) => {
          const duplicateId = duplicateIds.get(id);
          return duplicateId ? [duplicateId] : [];
        }),
      );
    }

    const next = [...app.scene.getElementsIncludingDeleted(), ...added];
    syncMovedIndices(next, arrayToMap(added));
    commitScene(ctx, next, {
      selectIds: copiesOfTargets[copiesOfTargets.length - 1],
    });

    const map = app.scene.getNonDeletedElementsMap();
    return {
      copies: copiesOfTargets.map((copyIds) =>
        copyIds.map((id) => serializeElement(map.get(id)!, map, "summary")),
      ),
    };
  },
};

export const editTools = [
  updateElements,
  moveElements,
  deleteElements,
  duplicateElementsTool,
];

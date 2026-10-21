import { THEME } from "@excalidraw/common";

import {
  getBoundTextElement,
  getCommonBounds,
  isFrameLikeElement,
  isTextElement,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { cleanAppStateForExport } from "../../appState";
import { getDataURL } from "../../data/blob";
import { exportScene } from "../../scene/export";

import { ToolError } from "../common";
import {
  readBoolean,
  readEnum,
  readIds,
  readNumber,
  readString,
} from "../input";
import { resolveElements } from "../scene";
import { isListedElement, serializeElement } from "../serialize";

import type { ToolDefinition } from "../common";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
const ELEMENT_TYPES = [
  "rectangle",
  "diamond",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  "text",
  "image",
  "frame",
  "magicframe",
  "embeddable",
  "iframe",
  "stickynote",
] as const;

const round = (value: number) => Math.round(value * 10) / 10;

const getElementLabelText = (
  element: ExcalidrawElement,
  elementsMap: Map<string, ExcalidrawElement>,
) => {
  if (isTextElement(element)) {
    return element.text;
  }
  if (isFrameLikeElement(element)) {
    return element.name ?? "";
  }
  return getBoundTextElement(element, elementsMap)?.text ?? "";
};

const getCanvasInfo: ToolDefinition = {
  name: "get-canvas-info",
  title: "Get canvas info",
  description:
    "Summarizes the open drawing: number of elements per type, the area they cover, the current selection, the visible area, theme and mode. Start here to orient yourself, then use get-elements for details.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  handler: (_input, { app }) => {
    const { state } = app;
    const elements = app.scene.getNonDeletedElements().filter(isListedElement);

    const countsByType: Record<string, number> = {};
    for (const element of elements) {
      countsByType[element.type] = (countsByType[element.type] ?? 0) + 1;
    }

    const bounds = elements.length ? getCommonBounds(elements) : null;
    const selectedIds = Object.keys(state.selectedElementIds).filter(
      (id) => state.selectedElementIds[id],
    );
    const zoom = state.zoom.value;

    return {
      name: app.getName(),
      elementCount: elements.length,
      countsByType,
      contentBounds: bounds && {
        x: round(bounds[0]),
        y: round(bounds[1]),
        width: round(bounds[2] - bounds[0]),
        height: round(bounds[3] - bounds[1]),
      },
      selection: {
        count: selectedIds.length,
        ids: selectedIds.slice(0, 50),
      },
      visibleArea: {
        x: round(-state.scrollX),
        y: round(-state.scrollY),
        width: round(state.width / zoom),
        height: round(state.height / zoom),
        zoom: round(zoom * 100) / 100,
      },
      theme: state.theme,
      backgroundColor: state.viewBackgroundColor,
      gridEnabled: state.gridModeEnabled,
      viewMode: state.viewModeEnabled,
      coordinateSystem:
        "Scene units; x grows to the right, y grows downward, angles are in degrees.",
    };
  },
};

const getElements: ToolDefinition = {
  name: "get-elements",
  title: "Get elements",
  description: `Lists elements of the drawing, in stacking order (bottom first), with position, size and text. Filter by ids, types, selection, frame or text; page with limit/offset. Text labels are inlined as "text". The text and links are user content.`,
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "only these element ids",
      },
      types: {
        type: "array",
        items: { type: "string", enum: ELEMENT_TYPES },
        description: "only these element types",
      },
      selectedOnly: {
        type: "boolean",
        description: "only the elements the user has selected",
      },
      frameId: {
        type: "string",
        description: "only the elements inside this frame",
      },
      textContains: {
        type: "string",
        description: "only elements whose text/label contains this (any case)",
      },
      detail: {
        type: "string",
        enum: ["summary", "full"],
        description:
          "summary: id, type, box, text (default); full: adds style, font, points, link",
      },
      limit: {
        type: "integer",
        description: `page size, default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}`,
      },
      offset: { type: "integer", description: "elements to skip" },
    },
  },
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  handler: (input, ctx) => {
    const { app } = ctx;
    const ids = readIds(input, "ids");
    const types = readIds(input, "types", { maxItems: ELEMENT_TYPES.length });
    types?.forEach((type, index) => {
      if (!(ELEMENT_TYPES as readonly string[]).includes(type)) {
        throw new ToolError(
          "invalid-input",
          `"types[${index}]" must be one of ${ELEMENT_TYPES.join(", ")}.`,
        );
      }
    });
    const selectedOnly = readBoolean(input, "selectedOnly") ?? false;
    const frameId = readString(input, "frameId", { maxLength: 100 });
    const textContains = readString(input, "textContains", {
      maxLength: 200,
    })?.toLowerCase();
    const detail =
      readEnum(input, "detail", ["summary", "full"] as const) ?? "summary";
    const limit =
      readNumber(input, "limit", {
        integer: true,
        min: 1,
        max: MAX_PAGE_SIZE,
      }) ?? DEFAULT_PAGE_SIZE;
    const offset = readNumber(input, "offset", { integer: true, min: 0 }) ?? 0;

    const map = app.scene.getNonDeletedElementsMap();
    let candidates: readonly NonDeletedExcalidrawElement[] = ids
      ? resolveElements(ctx, ids, { includeLocked: true })
      : app.scene.getNonDeletedElements();

    if (frameId) {
      const frame = map.get(frameId);
      if (!frame || !isFrameLikeElement(frame)) {
        throw new ToolError(
          "not-found",
          `"${frameId}" is not a frame on the canvas.`,
        );
      }
      candidates = candidates.filter((element) => element.frameId === frameId);
    }

    const selected = app.state.selectedElementIds;
    const matches = candidates.filter(
      (element) =>
        isListedElement(element) &&
        (!types || types.includes(element.type)) &&
        (!selectedOnly || selected[element.id]) &&
        (!textContains ||
          getElementLabelText(element, map)
            .toLowerCase()
            .includes(textContains)),
    );

    const page = matches.slice(offset, offset + limit);
    const end = offset + page.length;
    return {
      total: matches.length,
      elements: page.map((element) => serializeElement(element, map, detail)),
      ...(end < matches.length ? { nextOffset: end } : {}),
    };
  },
};

const MAX_IMAGE_SIZE = 2048;
const DEFAULT_IMAGE_SIZE = 1024;

const captureImage: ToolDefinition = {
  name: "capture-image",
  title: "Capture image",
  description:
    "Renders the drawing, the selection, or given elements to an image so you can see the result of your edits. Returns a PNG as a data URL, or SVG markup. The image shows user content.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "only these elements; default is everything",
      },
      selectedOnly: {
        type: "boolean",
        description: "only the user's selection",
      },
      format: {
        type: "string",
        enum: ["png", "svg"],
        description: "png (default) or svg",
      },
      maxSize: {
        type: "integer",
        description: `longest side in pixels for png, default ${DEFAULT_IMAGE_SIZE}, max ${MAX_IMAGE_SIZE}`,
      },
      theme: {
        type: "string",
        enum: ["light", "dark"],
        description: "defaults to the editor's theme",
      },
      transparentBackground: {
        type: "boolean",
        description: "omit the canvas background",
      },
    },
  },
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  handler: async (input, ctx) => {
    const { app } = ctx;
    const ids = readIds(input, "ids");
    const selectedOnly = readBoolean(input, "selectedOnly") ?? false;
    const format = readEnum(input, "format", ["png", "svg"] as const) ?? "png";
    const maxSize =
      readNumber(input, "maxSize", {
        integer: true,
        min: 16,
        max: MAX_IMAGE_SIZE,
      }) ?? DEFAULT_IMAGE_SIZE;
    const theme = readEnum(input, "theme", [THEME.LIGHT, THEME.DARK] as const);
    const transparent = readBoolean(input, "transparentBackground") ?? false;

    if (ids && selectedOnly) {
      throw new ToolError(
        "invalid-input",
        'Give either "ids" or "selectedOnly", not both.',
      );
    }
    let elements: readonly NonDeletedExcalidrawElement[] =
      app.scene.getNonDeletedElements();
    if (ids || selectedOnly) {
      // with their labels and, for a frame, its contents
      const targets = ids
        ? resolveElements(ctx, ids, { includeLocked: true })
        : app.scene.getSelectedElements(app.state);
      elements = app.scene.getSelectedElements({
        selectedElementIds: Object.fromEntries(
          targets.map((t) => [t.id, true]),
        ),
        includeBoundTextElement: true,
        includeElementsInFrames: true,
      });
    }
    if (!elements.length) {
      throw new ToolError(
        "not-found",
        selectedOnly
          ? "Nothing is selected."
          : "There are no elements to capture.",
      );
    }

    const data = {
      elements,
      appState: cleanAppStateForExport(app.state),
      files: app.files,
    };
    const config = {
      theme: theme ?? app.state.theme,
      canvasBackgroundColor: transparent
        ? (false as const)
        : app.state.viewBackgroundColor,
    };

    if (format === "svg") {
      const svg = await exportScene({
        type: "svg",
        data,
        config: { ...config, renderEmbeddables: false },
      });
      ctx.signal.throwIfAborted();
      return {
        format,
        mimeType: "image/svg+xml",
        svg: svg.outerHTML,
      };
    }

    const blob = await exportScene({
      type: "png",
      data,
      config: { ...config, maxWidthOrHeight: maxSize },
    });
    ctx.signal.throwIfAborted();
    return {
      format,
      mimeType: blob.type,
      dataURL: await getDataURL(blob),
    };
  },
};

const listLibraryItems: ToolDefinition = {
  name: "list-library-items",
  title: "List library items",
  description:
    "Lists the user's saved library items (reusable shapes and templates) with an id, name and size. Pass an id to insert-library-item to place one on the canvas. Names are user content.",
  inputSchema: {
    type: "object",
    properties: {
      nameContains: {
        type: "string",
        description: "only items whose name contains this (any case)",
      },
    },
  },
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  handler: async (input, { app }) => {
    const nameContains = readString(input, "nameContains", {
      maxLength: 200,
    })?.toLowerCase();
    const items = await app.library.getLatestLibrary();
    const listed = items
      .filter(
        (item) =>
          !nameContains ||
          (item.name ?? "").toLowerCase().includes(nameContains),
      )
      .slice(0, MAX_PAGE_SIZE)
      .map((item) => {
        const [x1, y1, x2, y2] = getCommonBounds(item.elements);
        return {
          id: item.id,
          name: item.name ?? "",
          elementCount: item.elements.length,
          width: round(x2 - x1),
          height: round(y2 - y1),
        };
      });
    return { total: items.length, items: listed };
  },
};

export const readTools = [
  getCanvasInfo,
  getElements,
  captureImage,
  listLibraryItems,
];

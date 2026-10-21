import { randomId } from "@excalidraw/common";

import {
  convertToExcalidrawElements,
  duplicateElements,
  getCommonBounds,
  isBindableElement,
  newElementWith,
} from "@excalidraw/element";

import { pointFrom } from "@excalidraw/math";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";
import type {
  ExcalidrawBindableElement,
  ExcalidrawElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { ToolError } from "../common";
import {
  isRecord,
  readArray,
  readBoolean,
  readColor,
  readEnum,
  readIds,
  readNumber,
  readRecord,
  readString,
} from "../input";
import { layoutLayered } from "../layout";
import {
  bindConnectors,
  commitScene,
  getConnectorGeometry,
  getFreePosition,
  resolveElements,
  revealElements,
} from "../scene";
import {
  STYLE_SCHEMA,
  TEXT_STYLE_SCHEMA,
  dropUndefined,
  getUserStyleDefaults,
  readStyle,
  readTextStyle,
  toElementProps,
} from "../style";
import { serializeElement } from "../serialize";

import type { ToolContext, ToolDefinition } from "../common";
import type { WebMCPJSONSchema } from "../types";

const MAX_ELEMENTS_PER_CALL = 100;
const MAX_TEXT_LENGTH = 5000;
const MAX_DIAGRAM_NODES = 60;
const MAX_DIAGRAM_EDGES = 120;

const SHAPES = ["rectangle", "ellipse", "diamond"] as const;
const ARROWHEADS = [
  "arrow",
  "bar",
  "circle",
  "circle_outline",
  "triangle",
  "triangle_outline",
  "diamond",
  "diamond_outline",
] as const;
const ARROW_KINDS = ["straight", "curved", "elbow"] as const;

type ArrowKind = typeof ARROW_KINDS[number];

const POSITION_SCHEMA: WebMCPJSONSchema = {
  type: "object",
  description:
    "scene coordinates for the top-left of the new content; default is free space beside the existing drawing",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
};

const SELECT_SCHEMA: WebMCPJSONSchema = {
  type: "boolean",
  description: "select what was created, default true",
};

const REVEAL_SCHEMA: WebMCPJSONSchema = {
  type: "boolean",
  description: "scroll to what was created if it's off-screen, default true",
};

const readPosition = (input: Record<string, unknown>) => {
  if (input.position == null) {
    return undefined;
  }
  const position = readRecord(input.position, "position");
  return {
    x: readNumber(position, "x", { required: true, path: "position.x" }),
    y: readNumber(position, "y", { required: true, path: "position.y" }),
  };
};

/** an arrow to bind between two of the elements being added */
type Connector = { arrowId: string; fromId: string; toId: string };

/** gives the arrows the geometry that runs between their elements */
const aimConnectors = (
  created: readonly ExcalidrawElement[],
  connectors: readonly Connector[],
) => {
  const byId = new Map(created.map((element) => [element.id, element]));
  for (const { arrowId, fromId, toId } of connectors) {
    const arrow = byId.get(arrowId)!;
    Object.assign(
      arrow,
      getConnectorGeometry(arrow, byId.get(fromId)!, byId.get(toId)!),
    );
  }
};

/**
 * Adds freshly created elements to the canvas, as one undoable step. The
 * content is moved so that its top-left corner lands on `position`, or on
 * free space when that isn't given.
 */
const insertElements = (
  ctx: ToolContext,
  created: readonly ExcalidrawElement[],
  input: Record<string, unknown>,
  connectors: readonly Connector[] = [],
) => {
  if (!created.length) {
    throw new ToolError("invalid-input", "There is nothing to add.");
  }
  const select = readBoolean(input, "select") ?? true;
  const reveal = readBoolean(input, "reveal") ?? true;

  const [minX, minY, maxX, maxY] = getCommonBounds(created);
  const target =
    readPosition(input) ?? getFreePosition(ctx, maxX - minX, maxY - minY);
  const dx = target.x - minX;
  const dy = target.y - minY;

  const placed = created.map((element) =>
    newElementWith(element, { x: element.x + dx, y: element.y + dy }),
  );

  const { app } = ctx;
  // arrows are bound against the scene, so the elements go in first
  app.scene.replaceAllElements([
    ...app.scene.getElementsIncludingDeleted(),
    ...placed,
  ]);
  bindConnectors(ctx, connectors);
  commitScene(ctx, app.scene.getElementsIncludingDeleted(), {
    selectIds: select ? placed.map((element) => element.id) : undefined,
  });

  const map = app.scene.getNonDeletedElementsMap();
  const live = placed.flatMap((element) => {
    const current = map.get(element.id);
    return current ? [current as NonDeletedExcalidrawElement] : [];
  });
  if (reveal) {
    revealElements(ctx, live);
  }
  return { placed, live, map };
};

const summarize = (
  live: readonly NonDeletedExcalidrawElement[],
  map: ReturnType<ToolContext["app"]["scene"]["getNonDeletedElementsMap"]>,
) =>
  live
    // bound labels are reported with their container
    .filter((element) => !(element.type === "text" && element.containerId))
    .map((element) => serializeElement(element, map, "summary"));

// ---------------------------------------------------------------------------
// add-elements
// ---------------------------------------------------------------------------

const ELEMENT_SCHEMA: WebMCPJSONSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [...SHAPES, "text", "arrow", "line", "frame"],
    },
    id: {
      type: "string",
      description:
        "your own name for the element, to reference it from arrows (from/to) or frames (children)",
    },
    x: { type: "number", description: "relative to the other new elements" },
    y: { type: "number", description: "relative to the other new elements" },
    width: { type: "number" },
    height: { type: "number" },
    text: { type: "string", description: "for type text" },
    label: {
      type: "string",
      description: "text centred in a shape, or on an arrow",
    },
    textColor: { type: "string", description: "color of the label text" },
    name: { type: "string", description: "title of a frame" },
    children: {
      type: "array",
      items: { type: "string" },
      description: "for frame: ids of the new elements it contains",
    },
    from: { type: "string", description: "for arrow: id of the start shape" },
    to: { type: "string", description: "for arrow: id of the end shape" },
    points: {
      type: "array",
      items: { type: "array", items: { type: "number" } },
      description: "for line/arrow: [x, y] points relative to x, y",
    },
    arrowKind: { type: "string", enum: ARROW_KINDS },
    startArrowhead: { type: "string", enum: ARROWHEADS },
    endArrowhead: { type: "string", enum: ARROWHEADS },
    ...STYLE_SCHEMA,
    ...TEXT_STYLE_SCHEMA,
  },
  required: ["type"],
};

const readArrowhead = (
  input: Record<string, unknown>,
  key: "startArrowhead" | "endArrowhead",
  path: string,
) => {
  const value = input[key];
  if (value === null || value === "none") {
    return null;
  }
  return readEnum(input, key, ARROWHEADS, { path });
};

const readPoints = (input: Record<string, unknown>, path: string) => {
  const points = readArray(input, "points", {
    minItems: 2,
    maxItems: 200,
    path,
  });
  return points?.map((point, index) => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !point.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      throw new ToolError(
        "invalid-input",
        `"${path}[${index}]" must be an [x, y] pair of numbers.`,
      );
    }
    return pointFrom<any>(point[0], point[1]);
  });
};

const arrowProps = (kind: ArrowKind | undefined) =>
  kind === "elbow"
    ? { elbowed: true, roundness: null }
    : kind === "straight"
    ? { elbowed: false, roundness: null }
    : kind === "curved"
    ? { elbowed: false, roundness: { type: 2 } }
    : {};

type ParsedElement = {
  skeleton: ExcalidrawElementSkeleton;
  /** the shapes the arrow runs between, to bind once they're placed */
  connect?: { from: string; to: string };
};

type References = {
  /** the agent's ids for this call's elements, and the ids they get */
  ids: ReadonlyMap<string, string>;
  types: ReadonlyMap<string, string>;
};

const parseElementSkeleton = (
  ctx: ToolContext,
  raw: unknown,
  index: number,
  refs: References,
): ParsedElement => {
  const path = `elements[${index}]`;
  const entry = readRecord(raw, path);
  const type = readEnum(
    entry,
    "type",
    [...SHAPES, "text", "arrow", "line", "frame"] as const,
    { required: true, path: `${path}.type` },
  );

  const id = readString(entry, "id", { maxLength: 100, path: `${path}.id` });
  const x = readNumber(entry, "x", { path: `${path}.x` }) ?? 0;
  const y = readNumber(entry, "y", { path: `${path}.y` }) ?? 0;
  const width = readNumber(entry, "width", {
    min: 0,
    path: `${path}.width`,
  });
  const height = readNumber(entry, "height", {
    min: 0,
    path: `${path}.height`,
  });
  const label = readString(entry, "label", {
    maxLength: MAX_TEXT_LENGTH,
    path: `${path}.label`,
  });
  const textColor = readColor(entry, "textColor", `${path}.textColor`);
  const style = {
    ...(type === "frame" ? {} : getUserStyleDefaults(ctx.app.state)),
    ...readStyle(entry, `${path}.`),
  };
  const textStyle = readTextStyle(entry, `${path}.`);
  const realId = id ? refs.ids.get(id) : undefined;
  const common = { ...(realId ? { id: realId } : {}), x, y };

  const labelProps = () =>
    label
      ? {
          label: {
            text: label,
            ...textStyle,
            ...(textColor ? { strokeColor: textColor } : {}),
          },
        }
      : {};

  switch (type) {
    case "rectangle":
    case "ellipse":
    case "diamond":
      return {
        skeleton: {
          type,
          ...common,
          ...dropUndefined({ width, height }),
          ...toElementProps(type, style),
          ...labelProps(),
        } as ExcalidrawElementSkeleton,
      };

    case "text": {
      const text = readString(entry, "text", {
        required: true,
        maxLength: MAX_TEXT_LENGTH,
        path: `${path}.text`,
      });
      if (!text.trim()) {
        throw new ToolError(
          "invalid-input",
          `"${path}.text" must not be empty.`,
        );
      }
      return {
        skeleton: {
          type,
          ...common,
          text,
          ...(style.strokeColor ? { strokeColor: style.strokeColor } : {}),
          ...(style.opacity !== undefined ? { opacity: style.opacity } : {}),
          ...textStyle,
        } as ExcalidrawElementSkeleton,
      };
    }

    case "arrow":
    case "line": {
      const from = readString(entry, "from", { path: `${path}.from` });
      const to = readString(entry, "to", { path: `${path}.to` });
      for (const [key, value] of [
        ["from", from],
        ["to", to],
      ] as const) {
        if (value === undefined) {
          continue;
        }
        if (!refs.ids.has(value)) {
          throw new ToolError(
            "invalid-input",
            `"${path}.${key}" refers to "${value}", which isn't the id of another element in this call. To connect elements already on the canvas, use connect-elements.`,
          );
        }
        const targetType = refs.types.get(value)!;
        if (!([...SHAPES, "text"] as string[]).includes(targetType)) {
          throw new ToolError(
            "invalid-input",
            `"${path}.${key}" refers to a ${targetType}; arrows connect shapes and text.`,
          );
        }
      }
      if ((from || to) && type !== "arrow") {
        throw new ToolError(
          "invalid-input",
          `"${path}": only arrows can have from/to.`,
        );
      }
      if (!from !== !to) {
        throw new ToolError(
          "invalid-input",
          `"${path}": give both from and to, or neither (and use x, y and width/height or points). To attach one end later, use connect-elements.`,
        );
      }
      if (from && from === to) {
        throw new ToolError(
          "invalid-input",
          `"${path}": from and to are the same element.`,
        );
      }
      const points = readPoints(entry, `${path}.points`);
      const arrowKind = readEnum(entry, "arrowKind", ARROW_KINDS, {
        path: `${path}.arrowKind`,
      });
      const connects = !!(from && to);
      const props: Record<string, unknown> = {
        type,
        ...common,
        // connected arrows get their geometry once the shapes are placed
        ...(connects && !realId ? { id: randomId() } : {}),
        ...(points && !connects
          ? { points }
          : dropUndefined({
              width: width ?? 100,
              height: height ?? 0,
            })),
        ...toElementProps(type, style),
        ...labelProps(),
      };
      if (type === "arrow") {
        Object.assign(props, arrowProps(arrowKind), {
          startArrowhead: readArrowhead(
            entry,
            "startArrowhead",
            `${path}.startArrowhead`,
          ),
          endArrowhead:
            readArrowhead(entry, "endArrowhead", `${path}.endArrowhead`) ??
            (entry.endArrowhead === undefined ? "arrow" : null),
        });
      }
      return {
        skeleton: props as ExcalidrawElementSkeleton,
        ...(connects
          ? {
              connect: {
                from: refs.ids.get(from!)!,
                to: refs.ids.get(to!)!,
              },
            }
          : {}),
      };
    }

    case "frame": {
      const children = readIds(entry, "children", { maxItems: 200 }) ?? [];
      const nested = children.filter(
        (child) => refs.types.get(child) === "frame",
      );
      if (nested.length) {
        throw new ToolError(
          "invalid-input",
          `"${path}.children" contains the frame ${nested
            .map((c) => `"${c}"`)
            .join(", ")}; frames can't be nested.`,
        );
      }
      const unknown = children.filter((child) => !refs.ids.has(child));
      if (unknown.length) {
        throw new ToolError(
          "invalid-input",
          `"${path}.children" refers to ${unknown
            .map((c) => `"${c}"`)
            .join(
              ", ",
            )}, which aren't ids of other elements in this call. To put elements already on the canvas into a frame, use wrap-in-frame.`,
        );
      }
      const name = readString(entry, "name", {
        maxLength: 200,
        path: `${path}.name`,
      });
      return {
        skeleton: {
          type: "frame",
          ...(realId ? { id: realId } : {}),
          children: children.map((child) => refs.ids.get(child)!),
          ...(name ? { name } : {}),
          // frames without a size fit their children
          ...(children.length
            ? {}
            : { x, y, width: width ?? 400, height: height ?? 300 }),
          ...(children.length && (width !== undefined || height !== undefined)
            ? { x, y, width, height }
            : {}),
        } as ExcalidrawElementSkeleton,
      };
    }
  }
};

const addElements: ToolDefinition = {
  name: "add-elements",
  title: "Add elements",
  description:
    "Draws shapes, text, arrows, lines and frames. Give coordinates relative to each other (start at 0,0); the group lands in free space, or at `position`. Shapes take a label; arrows can run between shapes via from/to ids defined in the same call. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      elements: {
        type: "array",
        items: ELEMENT_SCHEMA,
        description: `up to ${MAX_ELEMENTS_PER_CALL} elements`,
      },
      position: POSITION_SCHEMA,
      select: SELECT_SCHEMA,
      reveal: REVEAL_SCHEMA,
    },
    required: ["elements"],
  },
  annotations: {},
  handler: (input, ctx) => {
    const entries = readArray(input, "elements", {
      required: true,
      minItems: 1,
      maxItems: MAX_ELEMENTS_PER_CALL,
    });

    // the agent's own ids only name elements within this call; the elements
    // get fresh ids of their own, reported back in `ids`
    const ids = new Map<string, string>();
    const types = new Map<string, string>();
    entries.forEach((entry, index) => {
      const id = isRecord(entry) ? entry.id : undefined;
      if (typeof id === "string") {
        if (ids.has(id)) {
          throw new ToolError(
            "invalid-input",
            `"elements[${index}].id" repeats "${id}"; ids must be unique within a call.`,
          );
        }
        ids.set(id, randomId());
        types.set(id, String((entry as Record<string, unknown>).type));
      }
    });

    const parsed = entries.map((entry, index) =>
      parseElementSkeleton(ctx, entry, index, { ids, types }),
    );
    const created = convertToExcalidrawElements(
      parsed.map(({ skeleton }) => skeleton),
      { regenerateIds: false, renderEnvironment: ctx.app.renderEnvironment },
    );

    const connectors = parsed.flatMap(({ skeleton, connect }) =>
      connect
        ? [{ arrowId: skeleton.id!, fromId: connect.from, toId: connect.to }]
        : [],
    );
    aimConnectors(created, connectors);

    const { live, map } = insertElements(ctx, created, input, connectors);
    return {
      created: summarize(live, map),
      ...(ids.size ? { ids: Object.fromEntries(ids) } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// create-diagram
// ---------------------------------------------------------------------------

const DIAGRAM_STYLE_SCHEMA: Record<string, WebMCPJSONSchema> = {
  strokeColor: STYLE_SCHEMA.strokeColor,
  backgroundColor: {
    type: "string",
    description: "default fill for all nodes",
  },
  fillStyle: STYLE_SCHEMA.fillStyle,
  roughness: STYLE_SCHEMA.roughness,
  roundness: STYLE_SCHEMA.roundness,
};

const createDiagram: ToolDefinition = {
  name: "create-diagram",
  title: "Create diagram",
  description:
    "Draws a flowchart or graph from nodes and edges and arranges it automatically (top-down or left-to-right), with arrows bound to the nodes. Use for process flows, architectures, org charts and dependency graphs. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      nodes: {
        type: "array",
        description: `up to ${MAX_DIAGRAM_NODES} nodes`,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "your name, used by edges" },
            label: { type: "string" },
            shape: { type: "string", enum: SHAPES },
            backgroundColor: { type: "string" },
            strokeColor: { type: "string" },
            textColor: { type: "string" },
          },
          required: ["id", "label"],
        },
      },
      edges: {
        type: "array",
        description: `up to ${MAX_DIAGRAM_EDGES} directed edges`,
        items: {
          type: "object",
          properties: {
            from: { type: "string", description: "id of a node" },
            to: { type: "string", description: "id of a node" },
            label: { type: "string" },
            strokeStyle: {
              type: "string",
              enum: ["solid", "dashed", "dotted"],
            },
            bidirectional: {
              type: "boolean",
              description: "arrowheads at both ends",
            },
          },
          required: ["from", "to"],
        },
      },
      direction: {
        type: "string",
        enum: ["down", "right"],
        description: "down (default) or right",
      },
      title: { type: "string", description: "text above the diagram" },
      ...DIAGRAM_STYLE_SCHEMA,
      position: POSITION_SCHEMA,
      select: SELECT_SCHEMA,
      reveal: REVEAL_SCHEMA,
    },
    required: ["nodes"],
  },
  annotations: {},
  handler: (input, ctx) => {
    const nodeEntries = readArray(input, "nodes", {
      required: true,
      minItems: 1,
      maxItems: MAX_DIAGRAM_NODES,
    });
    const edgeEntries =
      readArray(input, "edges", { maxItems: MAX_DIAGRAM_EDGES }) ?? [];
    const direction =
      readEnum(input, "direction", ["down", "right"] as const) ?? "down";
    const title = readString(input, "title", { maxLength: 200 });
    const defaults = readStyle(input);
    const userStyle = getUserStyleDefaults(ctx.app.state);

    const ids = new Set<string>();
    const nodes = nodeEntries.map((raw, index) => {
      const path = `nodes[${index}]`;
      const node = readRecord(raw, path);
      const id = readString(node, "id", {
        required: true,
        maxLength: 100,
        path: `${path}.id`,
      });
      if (ids.has(id)) {
        throw new ToolError(
          "invalid-input",
          `"${path}.id" repeats "${id}"; node ids must be unique.`,
        );
      }
      ids.add(id);
      const shape =
        readEnum(node, "shape", SHAPES, { path: `${path}.shape` }) ??
        "rectangle";
      const label = readString(node, "label", {
        required: true,
        maxLength: 500,
        path: `${path}.label`,
      });
      if (!label.trim()) {
        throw new ToolError(
          "invalid-input",
          `"${path}.label" must not be empty.`,
        );
      }
      const textColor = readColor(node, "textColor", `${path}.textColor`);
      return {
        id,
        shape,
        label,
        style: {
          ...userStyle,
          ...defaults,
          ...readStyle(
            {
              strokeColor: node.strokeColor,
              backgroundColor: node.backgroundColor,
            },
            `${path}.`,
          ),
        },
        textColor,
      };
    });

    const edges = edgeEntries.map((raw, index) => {
      const path = `edges[${index}]`;
      const edge = readRecord(raw, path);
      const from = readString(edge, "from", {
        required: true,
        path: `${path}.from`,
      });
      const to = readString(edge, "to", { required: true, path: `${path}.to` });
      for (const [key, value] of [
        ["from", from],
        ["to", to],
      ] as const) {
        if (!ids.has(value)) {
          throw new ToolError(
            "invalid-input",
            `"${path}.${key}" is "${value}", which isn't a node id. Node ids: ${[
              ...ids,
            ]
              .slice(0, 20)
              .join(", ")}.`,
          );
        }
      }
      return {
        from,
        to,
        label: readString(edge, "label", {
          maxLength: 200,
          path: `${path}.label`,
        }),
        strokeStyle: readEnum(
          edge,
          "strokeStyle",
          ["solid", "dashed", "dotted"] as const,
          { path: `${path}.strokeStyle` },
        ),
        bidirectional: readBoolean(
          edge,
          "bidirectional",
          `${path}.bidirectional`,
        ),
        id: randomId(),
      };
    });

    const nodeIds = new Map(nodes.map((node) => [node.id, randomId()]));

    const nodeSkeleton = (
      node: typeof nodes[number],
      x: number,
      y: number,
      size?: { width: number; height: number },
    ) =>
      ({
        type: node.shape,
        id: nodeIds.get(node.id),
        x,
        y,
        ...(size ?? {}),
        ...toElementProps(node.shape, node.style),
        label: {
          text: node.label,
          ...(node.textColor ? { strokeColor: node.textColor } : {}),
        },
      } as ExcalidrawElementSkeleton);

    // measure the nodes (they size themselves around their label), lay them
    // out, then build the diagram for real
    const measured = convertToExcalidrawElements(
      nodes.map((node) => nodeSkeleton(node, 0, 0)),
      { regenerateIds: false, renderEnvironment: ctx.app.renderEnvironment },
    );
    const sizes = new Map(
      measured
        .filter((element) => element.type !== "text")
        .map((element) => [element.id, element]),
    );
    const layoutNodes = nodes.map((node) => {
      const element = sizes.get(nodeIds.get(node.id)!)!;
      return {
        id: node.id,
        width: Math.max(element.width, 100),
        height: Math.max(element.height, 60),
      };
    });
    const horizontal = direction === "right";
    const positions = layoutLayered(layoutNodes, edges, {
      direction: horizontal ? "LR" : "TB",
      nodeSpacing: 50,
      layerSpacing: edges.some((edge) => edge.label) ? 140 : 90,
    });

    const skeletons: ExcalidrawElementSkeleton[] = [
      ...nodes.map((node, index) => {
        const { x, y } = positions.get(node.id)!;
        const { width, height } = layoutNodes[index];
        return nodeSkeleton(node, x, y, { width, height });
      }),
      ...edges.map(
        (edge) =>
          ({
            type: "arrow",
            id: edge.id,
            x: 0,
            y: 0,
            width: 100,
            height: 0,
            startArrowhead: edge.bidirectional ? "arrow" : null,
            endArrowhead: "arrow",
            strokeColor: userStyle.strokeColor,
            ...(edge.strokeStyle ? { strokeStyle: edge.strokeStyle } : {}),
            ...(edge.label ? { label: { text: edge.label } } : {}),
          } as ExcalidrawElementSkeleton),
      ),
    ];

    const created = convertToExcalidrawElements(skeletons, {
      regenerateIds: false,
      renderEnvironment: ctx.app.renderEnvironment,
    });
    const connectors = edges.map((edge) => ({
      arrowId: edge.id,
      fromId: nodeIds.get(edge.from)!,
      toId: nodeIds.get(edge.to)!,
    }));
    aimConnectors(created, connectors);

    if (title) {
      const [minX, minY, maxX] = getCommonBounds(created);
      const [titleText] = convertToExcalidrawElements(
        [
          {
            type: "text",
            text: title,
            x: 0,
            y: 0,
            fontSize: 28,
            strokeColor: userStyle.strokeColor,
          },
        ],
        { renderEnvironment: ctx.app.renderEnvironment },
      );
      created.push(
        newElementWith(titleText, {
          x: (minX + maxX) / 2 - titleText.width / 2,
          y: minY - titleText.height - 40,
        }),
      );
    }

    const { live, map } = insertElements(ctx, created, input, connectors);
    return {
      nodeIds: Object.fromEntries(nodeIds),
      created: summarize(live, map),
    };
  },
};

// ---------------------------------------------------------------------------
// add-mermaid-diagram
// ---------------------------------------------------------------------------

const addMermaidDiagram: ToolDefinition = {
  name: "add-mermaid-diagram",
  title: "Add Mermaid diagram",
  description:
    "Draws a diagram from Mermaid syntax as editable shapes. Supports flowcharts and sequence diagrams (class and other types come in as images). Use when you already have Mermaid, otherwise create-diagram. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      mermaid: {
        type: "string",
        description: 'Mermaid source, e.g. "flowchart TD\\n  A --> B"',
      },
      position: POSITION_SCHEMA,
      select: SELECT_SCHEMA,
      reveal: REVEAL_SCHEMA,
    },
    required: ["mermaid"],
  },
  annotations: {},
  handler: async (input, ctx) => {
    const mermaid = readString(input, "mermaid", {
      required: true,
      maxLength: 20000,
    });
    const library = await import("@excalidraw/mermaid-to-excalidraw");
    let parsed;
    try {
      parsed = await library.parseMermaidToExcalidraw(mermaid);
    } catch (error) {
      throw new ToolError(
        "invalid-input",
        `The Mermaid code couldn't be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    ctx.signal.throwIfAborted();

    const created = convertToExcalidrawElements(parsed.elements, {
      regenerateIds: true,
      renderEnvironment: ctx.app.renderEnvironment,
    });
    if (parsed.files) {
      ctx.app.addFiles(Object.values(parsed.files));
    }
    const { live, map } = insertElements(ctx, created, input);
    return { created: summarize(live, map) };
  },
};

// ---------------------------------------------------------------------------
// connect-elements
// ---------------------------------------------------------------------------

const connectElements: ToolDefinition = {
  name: "connect-elements",
  title: "Connect elements",
  description:
    "Draws an arrow (or line) between two elements already on the canvas and binds it to them, so it follows when they move. Use for linking shapes you added earlier or the user drew. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "id of the start element" },
      to: { type: "string", description: "id of the end element" },
      label: { type: "string" },
      arrowKind: { type: "string", enum: ARROW_KINDS },
      startArrowhead: { type: "string", enum: ARROWHEADS },
      endArrowhead: { type: "string", enum: ARROWHEADS },
      strokeColor: STYLE_SCHEMA.strokeColor,
      strokeStyle: STYLE_SCHEMA.strokeStyle,
      select: SELECT_SCHEMA,
    },
    required: ["from", "to"],
  },
  annotations: {},
  handler: (input, ctx) => {
    const { app } = ctx;
    const fromId = readString(input, "from", { required: true });
    const toId = readString(input, "to", { required: true });
    if (fromId === toId) {
      throw new ToolError(
        "invalid-input",
        '"from" and "to" are the same element.',
      );
    }
    const [from, to] = [fromId, toId].map((id) => {
      const [element] = resolveElements(ctx, [id]);
      if (!isBindableElement(element)) {
        throw new ToolError(
          "invalid-input",
          `Element "${id}" is a ${element.type}; arrows connect shapes, text, images and frames. Give the id of one of those.`,
        );
      }
      return element as NonDeleted<ExcalidrawBindableElement>;
    });

    const label = readString(input, "label", { maxLength: 200 });
    const arrowKind = readEnum(input, "arrowKind", ARROW_KINDS);
    const style = readStyle({
      strokeColor: input.strokeColor,
      strokeStyle: input.strokeStyle,
    });
    const userStyle = getUserStyleDefaults(app.state);

    const skeleton = {
      type: "arrow",
      id: randomId(),
      x: 0,
      y: 0,
      width: 100,
      height: 0,
      strokeColor: style.strokeColor ?? userStyle.strokeColor,
      ...(style.strokeStyle ? { strokeStyle: style.strokeStyle } : {}),
      ...arrowProps(arrowKind),
      startArrowhead: readArrowhead(input, "startArrowhead", "startArrowhead"),
      endArrowhead:
        readArrowhead(input, "endArrowhead", "endArrowhead") ??
        (input.endArrowhead === undefined ? "arrow" : null),
      ...(label ? { label: { text: label } } : {}),
    } as ExcalidrawElementSkeleton;

    const created = convertToExcalidrawElements([skeleton], {
      regenerateIds: false,
      renderEnvironment: app.renderEnvironment,
    });
    const connector = { arrowId: skeleton.id!, fromId, toId };
    const arrow = created.find((element) => element.id === connector.arrowId)!;
    Object.assign(arrow, getConnectorGeometry(arrow, from, to));

    // bound against the scene, as dragging an arrow's end onto a shape does
    app.scene.replaceAllElements([
      ...app.scene.getElementsIncludingDeleted(),
      ...created,
    ]);
    bindConnectors(ctx, [connector]);
    commitScene(ctx, app.scene.getElementsIncludingDeleted(), {
      selectIds:
        readBoolean(input, "select") ?? true ? [connector.arrowId] : undefined,
    });

    const map = app.scene.getNonDeletedElementsMap();
    return {
      arrow: serializeElement(map.get(connector.arrowId)!, map, "summary"),
    };
  },
};

// ---------------------------------------------------------------------------
// insert-library-item
// ---------------------------------------------------------------------------

const insertLibraryItem: ToolDefinition = {
  name: "insert-library-item",
  title: "Insert library item",
  description:
    "Places a saved library item (from list-library-items) on the canvas as new elements, in free space or at `position`. One undo step.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "library item id" },
      position: POSITION_SCHEMA,
      select: SELECT_SCHEMA,
      reveal: REVEAL_SCHEMA,
    },
    required: ["id"],
  },
  annotations: {},
  handler: async (input, ctx) => {
    const id = readString(input, "id", { required: true });
    const items = await ctx.app.library.getLatestLibrary();
    ctx.signal.throwIfAborted();
    const item = items.find((candidate) => candidate.id === id);
    if (!item) {
      throw new ToolError(
        "not-found",
        `No library item with id "${id}". Use list-library-items to see the available ones.`,
      );
    }
    // fresh ids, groups and seeds, as a drop from the library gets
    const { duplicatedElements: created } = duplicateElements({
      type: "everything",
      elements: item.elements,
      randomizeSeed: true,
    });
    const { live, map } = insertElements(ctx, created, input);
    return { created: summarize(live, map) };
  },
};

export const createTools = [
  addElements,
  createDiagram,
  addMermaidDiagram,
  connectElements,
  insertLibraryItem,
];

import React from "react";
import { vi } from "vitest";

import { Excalidraw } from "../index";
import { ALL_TOOLS } from "../webmcp/tools";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PARAMETER_DESCRIPTION_LENGTH,
} from "../webmcp/common";

import { API } from "./helpers/api";
import {
  addBoxes,
  callTool,
  expectError,
  expectOk,
  installModelContext,
  renderEditorElement,
  sceneElements,
  uninstallModelContext,
} from "./helpers/webmcp";
import { act, render } from "./test-utils";

import type { WebMCPJSONSchema, WebMCPTool } from "../webmcp/types";

const { h } = window;

const renderEditor = (
  webMCP: React.ComponentProps<typeof Excalidraw>["webMCP"] = true,
) => renderEditorElement(<Excalidraw webMCP={webMCP} />);

let modelContext: ReturnType<typeof installModelContext>;

beforeEach(() => {
  modelContext = installModelContext();
});

afterEach(() => {
  uninstallModelContext();
});

/** the arrow's two ends in scene coordinates */
const arrowEnds = (arrowId: string) => {
  const arrow = h.elements.find((e) => e.id === arrowId) as any;
  const [first, ...rest] = arrow.points;
  const last = rest[rest.length - 1];
  return {
    start: { x: arrow.x + first[0], y: arrow.y + first[1] },
    end: { x: arrow.x + last[0], y: arrow.y + last[1] },
  };
};

/** how far a point is from the outline of an axis-aligned box (0 on it) */
const distanceToOutline = (
  point: { x: number; y: number },
  box: { x: number; y: number; width: number; height: number },
) => {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  if (dx || dy) {
    return Math.hypot(dx, dy);
  }
  // inside: distance to the nearest edge
  return Math.min(
    point.x - box.x,
    box.x + box.width - point.x,
    point.y - box.y,
    box.y + box.height - point.y,
  );
};

/** asserts that the arrow runs from the outline of one box to another's */
const expectArrowBetween = (arrowId: string, fromId: string, toId: string) => {
  const { start, end } = arrowEnds(arrowId);
  const from = h.elements.find((e) => e.id === fromId)!;
  const to = h.elements.find((e) => e.id === toId)!;
  expect(distanceToOutline(start, from)).toBeLessThan(12);
  expect(distanceToOutline(end, to)).toBeLessThan(12);
};

describe("WebMCP registration", () => {
  it("registers nothing unless asked to", async () => {
    await render(<Excalidraw />);
    expect(modelContext.registerTool).not.toHaveBeenCalled();
  });

  it("does nothing where the browser has no WebMCP", async () => {
    delete (document as any).modelContext;
    await expect(renderEditor()).resolves.toBeDefined();
  });

  it("registers every tool once the editor is mounted", async () => {
    await renderEditor();
    expect([...modelContext.tools.keys()].sort()).toEqual(
      ALL_TOOLS.map((tool) => tool.name).sort(),
    );
  });

  it("withdraws the tools when the editor unmounts", async () => {
    const { unmount } = await renderEditor();
    expect(modelContext.tools.size).toBeGreaterThan(0);
    unmount();
    expect(modelContext.tools.size).toBe(0);
  });

  it("follows the prop", async () => {
    const { rerender } = await renderEditor(false);
    expect(modelContext.tools.size).toBe(0);
    rerender(<Excalidraw webMCP />);
    expect(modelContext.tools.size).toBe(ALL_TOOLS.length);
    rerender(<Excalidraw webMCP={false} />);
    expect(modelContext.tools.size).toBe(0);
  });

  it("registers once, and again after a remount, in StrictMode", async () => {
    const { unmount } = await renderEditorElement(
      <React.StrictMode>
        <Excalidraw webMCP />
      </React.StrictMode>,
    );
    expect(modelContext.tools.size).toBe(ALL_TOOLS.length);
    expect(
      expectOk(
        await callTool("add-elements", { elements: [{ type: "rectangle" }] }),
      ).created,
    ).toHaveLength(1);
    unmount();
    expect(modelContext.tools.size).toBe(0);
  });

  it("exposes only the reading tools in read-only mode", async () => {
    await renderEditor({ readOnly: true });
    const names = [...modelContext.tools.keys()];
    expect(names.length).toBeGreaterThan(0);
    for (const tool of modelContext.tools.values()) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    expect(names).not.toContain("add-elements");
    expect(names).toContain("get-elements");
  });

  it("passes exposedTo along", async () => {
    await renderEditor({ exposedTo: ["https://example.com"] });
    expect(modelContext.registerTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ exposedTo: ["https://example.com"] }),
    );
  });

  it("warns, rather than throws, when a name is taken", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    modelContext.tools.set("get-elements", {} as WebMCPTool);
    await renderEditor();
    await act(async () => {});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"get-elements"'),
      expect.any(Error),
    );
    warn.mockRestore();
  });
});

describe("WebMCP tool definitions follow the guidelines", () => {
  const collectDescriptions = (
    schema: WebMCPJSONSchema,
    path: string,
  ): [string, string][] => [
    ...(schema.description
      ? [[path, schema.description] as [string, string]]
      : []),
    ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
      collectDescriptions(child, `${path}.${key}`),
    ),
    ...(schema.items ? collectDescriptions(schema.items, `${path}[]`) : []),
  ];

  it("has valid, unique, concise names and descriptions", () => {
    const names = new Set<string>();
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(tool.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      expect(tool.title).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.description.length).toBeLessThanOrEqual(
        MAX_DESCRIPTION_LENGTH,
      );
    }
  });

  it("describes parameters briefly", () => {
    const tooLong = ALL_TOOLS.flatMap((tool) =>
      collectDescriptions(tool.inputSchema, tool.name).filter(
        ([, description]) =>
          description.length > MAX_PARAMETER_DESCRIPTION_LENGTH,
      ),
    );
    expect(tooLong).toEqual([]);
  });

  it("uses object schemas whose required fields exist", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      for (const key of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties).toHaveProperty([key]);
      }
    }
  });

  it("marks read-only tools, and flags only clear-canvas as consequential", () => {
    const readOnly = ALL_TOOLS.filter((t) => t.annotations.readOnlyHint).map(
      (t) => t.name,
    );
    expect(readOnly.sort()).toEqual(
      [
        "capture-image",
        "get-canvas-info",
        "get-elements",
        "list-library-items",
      ].sort(),
    );
    expect(
      ALL_TOOLS.filter((t) => t.annotations.consequentialHint).map(
        (t) => t.name,
      ),
    ).toEqual(["clear-canvas"]);
  });

  it("flags the tools that return user content as untrusted", () => {
    for (const name of [
      "get-elements",
      "capture-image",
      "list-library-items",
    ]) {
      expect(
        ALL_TOOLS.find((t) => t.name === name)!.annotations
          .untrustedContentHint,
      ).toBe(true);
    }
  });

  it("offers the optimistic-concurrency guard on every writing tool", async () => {
    await renderEditor();
    for (const tool of modelContext.tools.values()) {
      const writes = !tool.annotations?.readOnlyHint;
      expect(
        "expectedSceneVersion" in (tool.inputSchema.properties ?? {}),
      ).toBe(writes);
    }
  });
});

describe("WebMCP common behavior", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("returns errors as data, with a message to correct the call", async () => {
    const message = expectError(
      await callTool("update-elements", { updates: [{ id: "nope", x: 1 }] }),
      "not-found",
    );
    expect(message).toContain("nope");
    expect(message).toContain("get-elements");
  });

  it("rejects invalid input by naming the parameter", async () => {
    const message = expectError(
      await callTool("add-elements", {
        elements: [{ type: "rectangle", strokeColor: "not a color!" }],
      }),
      "invalid-input",
    );
    expect(message).toContain("elements[0].strokeColor");
  });

  it("refuses to change a canvas in view mode but still reads it", async () => {
    await addBoxes({ a: { x: 0, y: 0 } });
    act(() => h.setState({ viewModeEnabled: true }));
    expectError(
      await callTool("add-elements", {
        elements: [{ type: "rectangle" }],
      }),
      "view-mode",
    );
    expectOk(await callTool("get-elements"));
  });

  it("refuses a change based on a stale read", async () => {
    await addBoxes({ a: { x: 0, y: 0 } });
    const { sceneVersion } = expectOk(await callTool("get-canvas-info"));
    API.updateScene({
      elements: [
        ...h.elements,
        API.createElement({ type: "ellipse", x: 500, y: 500 }),
      ],
    });
    const message = expectError(
      await callTool("add-elements", {
        elements: [{ type: "rectangle" }],
        expectedSceneVersion: sceneVersion,
      }),
      "scene-changed",
    );
    expect(message).toContain("Read it again");
    expect(sceneElements()).toHaveLength(2);

    const current = expectOk(await callTool("get-canvas-info")).sceneVersion;
    expectOk(
      await callTool("add-elements", {
        elements: [{ type: "rectangle" }],
        expectedSceneVersion: current,
      }),
    );
    expect(sceneElements()).toHaveLength(3);
  });

  it("reports the scene version after every call", async () => {
    const before = expectOk(await callTool("get-canvas-info")).sceneVersion;
    const after = expectOk(
      await callTool("add-elements", { elements: [{ type: "rectangle" }] }),
    ).sceneVersion;
    expect(after).not.toBe(before);
  });

  it("stops when the call is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      callTool("get-elements", {}, controller.signal),
    ).rejects.toBeDefined();
  });

  it("reports an editor that went away", async () => {
    const tool = modelContext.tools.get("get-elements")!;
    act(() => {
      h.app.componentWillUnmount();
    });
    const result = await tool.execute(
      {},
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });
});

describe("get-canvas-info and get-elements", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("summarizes an empty canvas", async () => {
    const info = expectOk(await callTool("get-canvas-info"));
    expect(info).toMatchObject({
      elementCount: 0,
      countsByType: {},
      contentBounds: null,
      selection: { count: 0, ids: [] },
      viewMode: false,
    });
  });

  it("counts elements by type, inlining labels", async () => {
    await callTool("add-elements", {
      elements: [
        { type: "rectangle", label: "Box" },
        { type: "text", text: "hello" },
        { type: "arrow", width: 50 },
      ],
    });
    const info = expectOk(await callTool("get-canvas-info"));
    expect(info.countsByType).toEqual({ rectangle: 1, text: 1, arrow: 1 });
    expect(info.elementCount).toBe(3);
    expect(info.contentBounds.width).toBeGreaterThan(0);
    // what was added is selected
    expect(info.selection.count).toBe(3);
  });

  it("lists elements with their labels and pages through them", async () => {
    await addBoxes({
      a: { x: 0, y: 0, label: "Alpha" },
      b: { x: 200, y: 0, label: "Beta" },
      c: { x: 400, y: 0, label: "Gamma" },
    });
    const first = expectOk(await callTool("get-elements", { limit: 2 }));
    expect(first.total).toBe(3);
    expect(first.elements.map((e: any) => e.text)).toEqual(["Alpha", "Beta"]);
    expect(first.nextOffset).toBe(2);
    // labels aren't listed as elements of their own
    expect(first.elements.every((e: any) => e.type === "rectangle")).toBe(true);

    const rest = expectOk(
      await callTool("get-elements", { limit: 2, offset: first.nextOffset }),
    );
    expect(rest.elements.map((e: any) => e.text)).toEqual(["Gamma"]);
    expect(rest.nextOffset).toBeUndefined();
  });

  it("filters by id, type, text, selection and frame", async () => {
    const [a, b] = await addBoxes({
      a: { x: 0, y: 0, label: "Alpha" },
      b: { x: 200, y: 0, label: "Beta" },
    });
    await callTool("add-elements", {
      elements: [{ type: "ellipse" }],
      select: false,
    });
    expect(
      expectOk(await callTool("get-elements", { ids: [b.id] })).elements,
    ).toHaveLength(1);
    expect(
      expectOk(await callTool("get-elements", { types: ["ellipse"] })).total,
    ).toBe(1);
    expect(
      expectOk(await callTool("get-elements", { textContains: "ALP" }))
        .elements[0].id,
    ).toBe(a.id);
    await callTool("select-elements", { ids: [a.id] });
    expect(
      expectOk(await callTool("get-elements", { selectedOnly: true })).total,
    ).toBe(1);

    const framed = expectOk(
      await callTool("wrap-in-frame", { ids: [a.id], name: "Section" }),
    );
    const inFrame = expectOk(
      await callTool("get-elements", { frameId: framed.frame.id }),
    );
    expect(inFrame.elements.map((e: any) => e.id)).toEqual([a.id]);
    expectError(await callTool("get-elements", { frameId: b.id }), "not-found");
  });

  it("returns full detail on request, with angles in degrees", async () => {
    const [box] = await addBoxes({ a: { x: 0, y: 0 } });
    await callTool("update-elements", {
      updates: [{ id: box.id, angle: 90, strokeColor: "#ff0000" }],
    });
    const { elements } = expectOk(
      await callTool("get-elements", { ids: [box.id], detail: "full" }),
    );
    expect(elements[0]).toMatchObject({
      angle: 90,
      strokeColor: "#ff0000",
      fillStyle: expect.any(String),
      roughness: expect.any(Number),
    });
  });

  it("truncates long text", async () => {
    await callTool("add-elements", {
      elements: [{ type: "text", text: "x".repeat(2000) }],
    });
    const { elements } = expectOk(await callTool("get-elements"));
    expect(elements[0].text.length).toBeLessThan(500);
    expect(elements[0].text).toContain("more characters");
  });

  it("rejects bad filters", async () => {
    expectError(
      await callTool("get-elements", { types: ["blob"] }),
      "invalid-input",
    );
    expectError(await callTool("get-elements", { limit: 0 }), "invalid-input");
    expectError(
      await callTool("get-elements", { limit: 500 }),
      "invalid-input",
    );
  });
});

describe("add-elements", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("draws shapes, text and lines in one undo step", async () => {
    const { created } = expectOk(
      await callTool("add-elements", {
        elements: [
          { type: "rectangle", width: 120, height: 80, label: "Server" },
          { type: "ellipse", x: 200, width: 80, height: 80 },
          { type: "diamond", x: 320, width: 80, height: 80 },
          { type: "text", x: 0, y: 150, text: "Caption", fontSize: 28 },
          {
            type: "line",
            x: 0,
            y: 200,
            points: [
              [0, 0],
              [100, 30],
              [200, 0],
            ],
          },
        ],
      }),
    );
    expect(created.map((e: any) => e.type)).toEqual([
      "rectangle",
      "ellipse",
      "diamond",
      "text",
      "line",
    ]);
    expect(created[0].text).toBe("Server");
    expect(API.getUndoStack()).toHaveLength(1);

    await callTool("undo");
    expect(sceneElements()).toHaveLength(0);
  });

  it("places new content in free space, beside what's there", async () => {
    const [first] = await addBoxes({ a: { x: 0, y: 0 } });
    const { created } = expectOk(
      await callTool("add-elements", { elements: [{ type: "rectangle" }] }),
    );
    expect(created[0].x).toBeGreaterThan(first.x + 100);
    expect(created[0].y).toBe(first.y);
  });

  it("centres the first content in the viewport", async () => {
    const { created } = expectOk(
      await callTool("add-elements", {
        elements: [{ type: "rectangle", width: 100, height: 100 }],
      }),
    );
    const { scrollX, scrollY, width, height, zoom } = h.state;
    expect(created[0].x + 50).toBeCloseTo(-scrollX + width / zoom.value / 2);
    expect(created[0].y + 50).toBeCloseTo(-scrollY + height / zoom.value / 2);
  });

  it("places the group's top-left corner at `position`", async () => {
    const { created } = expectOk(
      await callTool("add-elements", {
        elements: [
          { type: "rectangle", x: 50, y: 70, width: 10, height: 10 },
          { type: "rectangle", x: 90, y: 70, width: 10, height: 10 },
        ],
        position: { x: 1000, y: 2000 },
      }),
    );
    expect(created.map((e: any) => [e.x, e.y])).toEqual([
      [1000, 2000],
      [1040, 2000],
    ]);
  });

  it("binds arrows to shapes by the ids given in the call", async () => {
    const { created } = expectOk(
      await callTool("add-elements", {
        elements: [
          { type: "rectangle", id: "a", width: 100, height: 60, label: "A" },
          {
            type: "rectangle",
            id: "b",
            x: 300,
            width: 100,
            height: 60,
            label: "B",
          },
          { type: "arrow", from: "a", to: "b", label: "calls" },
        ],
      }),
    );
    const [a, b, arrow] = created;
    expect(arrow).toMatchObject({
      type: "arrow",
      from: a.id,
      to: b.id,
      text: "calls",
    });
    // the arrow runs between the shapes
    expect(arrow.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
    expect(arrow.x + arrow.width).toBeLessThanOrEqual(b.x + 1);
    // and the shapes know about it
    const shape = h.elements.find((e) => e.id === a.id)!;
    expect(shape.boundElements?.some((be) => be.type === "arrow")).toBe(true);
  });

  it.each(["straight", "curved", "elbow"])(
    "runs %s arrows between the outlines of the shapes",
    async (arrowKind) => {
      const { created } = expectOk(
        await callTool("add-elements", {
          elements: [
            { type: "rectangle", id: "a", width: 100, height: 60, label: "A" },
            {
              type: "rectangle",
              id: "b",
              x: 300,
              y: 200,
              width: 100,
              height: 60,
              label: "B",
            },
            { type: "arrow", from: "a", to: "b", arrowKind },
          ],
        }),
      );
      expectArrowBetween(created[2].id, created[0].id, created[1].id);
    },
  );

  it("puts new elements in a frame sized around them", async () => {
    const { created } = expectOk(
      await callTool("add-elements", {
        elements: [
          { type: "rectangle", id: "a", width: 100, height: 60 },
          { type: "text", id: "t", y: 100, text: "inside" },
          { type: "frame", name: "Group", children: ["a", "t"] },
        ],
      }),
    );
    const frame = created.find((e: any) => e.type === "frame");
    expect(frame.name).toBe("Group");
    const inside = created.filter((e: any) => e.frameId === frame.id);
    expect(inside).toHaveLength(2);
    expect(frame.width).toBeGreaterThanOrEqual(100);
    // children are drawn above their frame
    const order = h.elements.map((e) => e.id);
    expect(order.indexOf(frame.id)).toBeGreaterThan(-1);
  });

  it("uses the user's current style unless told otherwise", async () => {
    act(() => h.setState({ currentItemStrokeColor: "#e03131" }));
    await callTool("add-elements", {
      elements: [
        { type: "rectangle" },
        {
          type: "rectangle",
          strokeColor: "#1971c2",
          backgroundColor: "#a5d8ff",
        },
      ],
    });
    const [plain, styled] = sceneElements();
    expect(plain.strokeColor).toBe("#e03131");
    expect(styled).toMatchObject({
      strokeColor: "#1971c2",
      backgroundColor: "#a5d8ff",
    });
  });

  it("supports elbow and curved arrows, and arrowheads", async () => {
    await callTool("add-elements", {
      elements: [
        { type: "arrow", width: 100, height: 50, arrowKind: "elbow" },
        {
          type: "arrow",
          y: 100,
          width: 100,
          arrowKind: "curved",
          startArrowhead: "triangle",
          endArrowhead: "none",
        },
      ],
    });
    const [elbow, curved] = sceneElements() as any[];
    expect(elbow.elbowed).toBe(true);
    expect(curved.elbowed).toBe(false);
    expect(curved.roundness).toBeTruthy();
    expect(curved.startArrowhead).toBe("triangle");
    expect(curved.endArrowhead).toBeNull();
  });

  it("selects and reveals what it adds, unless told not to", async () => {
    const { created } = expectOk(
      await callTool("add-elements", { elements: [{ type: "rectangle" }] }),
    );
    expect(h.state.selectedElementIds).toEqual({ [created[0].id]: true });

    await callTool("add-elements", {
      elements: [{ type: "rectangle" }],
      select: false,
    });
    expect(h.state.selectedElementIds).toEqual({ [created[0].id]: true });
  });

  it.each([
    [{ elements: [] }, "elements"],
    [{ elements: [{ type: "star" }] }, "elements[0].type"],
    [{ elements: [{ type: "rectangle", width: -5 }] }, "elements[0].width"],
    [{ elements: [{ type: "text" }] }, "elements[0].text"],
    [
      { elements: [{ type: "rectangle", opacity: 500 }] },
      "elements[0].opacity",
    ],
    [{ elements: [{ type: "line", points: [[0, 0]] }] }, "elements[0].points"],
    [
      {
        elements: [
          {
            type: "line",
            points: [
              [0, "x"],
              [1, 1],
            ],
          },
        ],
      },
      "elements[0].points[0]",
    ],
    [{ elements: [{ type: "arrow", from: "ghost" }] }, "elements[0].from"],
    [
      { elements: [{ type: "frame", children: ["ghost"] }] },
      "elements[0].children",
    ],
    [
      {
        elements: [
          { type: "rectangle", id: "a" },
          { type: "rectangle", id: "a" },
        ],
      },
      "elements[1].id",
    ],
    [{ elements: [{ type: "rectangle" }], position: { x: 1 } }, "position.y"],
  ])("rejects %j", async (input, parameter) => {
    const message = expectError(
      await callTool("add-elements", input as any),
      "invalid-input",
    );
    expect(message).toContain(parameter);
    expect(sceneElements()).toHaveLength(0);
  });

  it("limits the size of a call", async () => {
    expectError(
      await callTool("add-elements", {
        elements: Array.from({ length: 101 }, () => ({ type: "rectangle" })),
      }),
      "invalid-input",
    );
  });
});

describe("create-diagram", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  const flow = {
    nodes: [
      { id: "start", label: "Start", shape: "ellipse" },
      { id: "check", label: "Valid?", shape: "diamond" },
      { id: "ok", label: "Save" },
      { id: "bad", label: "Show error" },
    ],
    edges: [
      { from: "start", to: "check" },
      { from: "check", to: "ok", label: "yes" },
      { from: "check", to: "bad", label: "no" },
    ],
  };

  it("draws the nodes laid out in layers, with bound arrows", async () => {
    const result = expectOk(await callTool("create-diagram", flow));
    const byText = (text: string) =>
      result.created.find((e: any) => e.text === text);

    const start = byText("Start");
    const check = byText("Valid?");
    const ok = byText("Save");
    const bad = byText("Show error");
    expect(start.type).toBe("ellipse");
    expect(check.type).toBe("diamond");
    // top-down: each layer below the previous, siblings side by side
    expect(start.y).toBeLessThan(check.y);
    expect(check.y).toBeLessThan(ok.y);
    expect(ok.y).toBe(bad.y);
    expect(Math.abs(ok.x - bad.x)).toBeGreaterThan(100);

    const arrows = result.created.filter((e: any) => e.type === "arrow");
    expect(arrows).toHaveLength(3);
    expect(arrows.map((a: any) => [a.from, a.to])).toEqual([
      [start.id, check.id],
      [check.id, ok.id],
      [check.id, bad.id],
    ]);
    expect(arrows.map((a: any) => a.text)).toEqual([undefined, "yes", "no"]);

    // nodeIds maps the agent's ids to the elements'
    expect(result.nodeIds).toEqual({
      start: start.id,
      check: check.id,
      ok: ok.id,
      bad: bad.id,
    });
    expect(API.getUndoStack()).toHaveLength(1);
  });

  it("runs its arrows between the outlines of the nodes", async () => {
    const result = expectOk(
      await callTool("create-diagram", {
        nodes: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "c" },
        ],
      }),
    );
    for (const arrow of result.created.filter((e: any) => e.type === "arrow")) {
      expectArrowBetween(arrow.id, arrow.from, arrow.to);
    }
  });

  it("lays out left to right", async () => {
    const result = expectOk(
      await callTool("create-diagram", { ...flow, direction: "right" }),
    );
    const start = result.created.find((e: any) => e.text === "Start");
    const check = result.created.find((e: any) => e.text === "Valid?");
    expect(start.x).toBeLessThan(check.x);
  });

  it("keeps arrows attached when a node moves", async () => {
    const result = expectOk(await callTool("create-diagram", flow));
    const arrowId = result.created.find((e: any) => e.type === "arrow").id;
    const before = (h.elements.find((e) => e.id === arrowId) as any).points;
    await callTool("move-elements", {
      ids: [result.nodeIds.check],
      dx: 0,
      dy: 150,
    });
    const after = (h.elements.find((e) => e.id === arrowId) as any).points;
    expect(after).not.toEqual(before);
  });

  it("adds a title, bidirectional and dashed edges, and shared styles", async () => {
    const result = expectOk(
      await callTool("create-diagram", {
        title: "Checkout",
        backgroundColor: "#d0ebff",
        nodes: [
          { id: "a", label: "A" },
          { id: "b", label: "B", backgroundColor: "#ffec99" },
        ],
        edges: [
          { from: "a", to: "b", bidirectional: true, strokeStyle: "dashed" },
        ],
      }),
    );
    expect(result.created.some((e: any) => e.text === "Checkout")).toBe(true);
    const a = h.elements.find((e) => e.id === result.nodeIds.a)!;
    const b = h.elements.find((e) => e.id === result.nodeIds.b)!;
    expect(a.backgroundColor).toBe("#d0ebff");
    expect(b.backgroundColor).toBe("#ffec99");
    const arrow = h.elements.find((e) => e.type === "arrow") as any;
    expect(arrow.startArrowhead).toBe("arrow");
    expect(arrow.endArrowhead).toBe("arrow");
    expect(arrow.strokeStyle).toBe("dashed");
  });

  it("copes with cycles", async () => {
    expectOk(
      await callTool("create-diagram", {
        nodes: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      }),
    );
    expect(sceneElements().filter((e) => e.type === "arrow")).toHaveLength(2);
  });

  it.each([
    [{ nodes: [] }, "nodes"],
    [{ nodes: [{ id: "a" }] }, "nodes[0].label"],
    [
      {
        nodes: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
        ],
      },
      "nodes[1].id",
    ],
    [
      { nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "zzz" }] },
      "edges[0].to",
    ],
    [{ nodes: [{ id: "a", label: "A", shape: "hexagon" }] }, "nodes[0].shape"],
    [{ nodes: [{ id: "a", label: "A" }], direction: "up" }, "direction"],
  ])("rejects %j", async (input, parameter) => {
    const message = expectError(
      await callTool("create-diagram", input as any),
      "invalid-input",
    );
    expect(message).toContain(parameter);
    expect(sceneElements()).toHaveLength(0);
  });
});

describe("connect-elements", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("binds an arrow between two elements on the canvas", async () => {
    const [a, b] = await addBoxes({
      a: { x: 0, y: 0, label: "A" },
      b: { x: 400, y: 0, label: "B" },
    });
    const { arrow } = expectOk(
      await callTool("connect-elements", {
        from: a.id,
        to: b.id,
        label: "depends on",
        strokeStyle: "dotted",
        startArrowhead: "circle",
      }),
    );
    expect(arrow).toMatchObject({
      type: "arrow",
      from: a.id,
      to: b.id,
      text: "depends on",
    });
    const element = h.elements.find((e) => e.id === arrow.id) as any;
    expect(element.strokeStyle).toBe("dotted");
    expect(element.startArrowhead).toBe("circle");
    expect(API.getUndoStack()).toHaveLength(2);
    expectArrowBetween(arrow.id, a.id, b.id);

    // the arrow follows its shapes
    const before = element.points;
    await callTool("move-elements", { ids: [b.id], dx: 0, dy: 200 });
    expect(
      (h.elements.find((e) => e.id === arrow.id) as any).points,
    ).not.toEqual(before);
  });

  it("makes elbow arrows", async () => {
    const [a, b] = await addBoxes({ a: { x: 0, y: 0 }, b: { x: 300, y: 200 } });
    const { arrow } = expectOk(
      await callTool("connect-elements", {
        from: a.id,
        to: b.id,
        arrowKind: "elbow",
      }),
    );
    const element = h.elements.find((e) => e.id === arrow.id) as any;
    expect(element.elbowed).toBe(true);
    // routed between the shapes, ending on their outlines (not their centres)
    expectArrowBetween(arrow.id, a.id, b.id);
    expect(element.points.length).toBeGreaterThan(2);
  });

  it("leaves an elbow arrow sideways between boxes that are side by side", async () => {
    // far apart diagonally: the flowchart convention is to go out of the side
    const [a, b] = await addBoxes({ a: { x: 0, y: 600 }, b: { x: 400, y: 0 } });
    const { arrow } = expectOk(
      await callTool("connect-elements", {
        from: a.id,
        to: b.id,
        arrowKind: "elbow",
      }),
    );
    const points = (h.elements.find((e) => e.id === arrow.id) as any).points;
    // the first segment runs along x (same y as the start)
    expect(points[1][1]).toBe(0);
    expect(points[1][0]).toBeGreaterThan(0);
    expectArrowBetween(arrow.id, a.id, b.id);
  });

  it("explains what can't be connected", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    await callTool("add-elements", {
      elements: [{ type: "line", width: 100 }],
      select: false,
    });
    const line = sceneElements().find((e) => e.type === "line")!;
    expectError(
      await callTool("connect-elements", { from: a.id, to: a.id }),
      "invalid-input",
    );
    expect(
      expectError(
        await callTool("connect-elements", { from: a.id, to: line.id }),
        "invalid-input",
      ),
    ).toContain("line");
    expectError(
      await callTool("connect-elements", { from: a.id, to: "gone" }),
      "not-found",
    );
  });
});

describe("update-elements", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("changes only the given fields", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    const before = h.elements.find((e) => e.id === a.id)!;
    expectOk(
      await callTool("update-elements", {
        updates: [
          {
            id: a.id,
            backgroundColor: "#ffc9c9",
            fillStyle: "solid",
            strokeWidth: 4,
            opacity: 50,
            roundness: "round",
            width: 250,
          },
        ],
      }),
    );
    const after = h.elements.find((e) => e.id === a.id)!;
    expect(after).toMatchObject({
      backgroundColor: "#ffc9c9",
      fillStyle: "solid",
      strokeWidth: 4,
      opacity: 50,
      width: 250,
      strokeColor: before.strokeColor,
      height: before.height,
      x: before.x,
    });
    expect(after.roundness).toBeTruthy();
  });

  it("applies several updates as one undo step", async () => {
    const [a, b] = await addBoxes({ a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    const undoDepth = API.getUndoStack().length;
    await callTool("update-elements", {
      updates: [
        { id: a.id, strokeColor: "#e03131" },
        { id: b.id, strokeColor: "#2f9e44" },
      ],
    });
    expect(API.getUndoStack()).toHaveLength(undoDepth + 1);
    await callTool("undo");
    expect(h.elements.find((e) => e.id === a.id)!.strokeColor).not.toBe(
      "#e03131",
    );
    expect(h.elements.find((e) => e.id === b.id)!.strokeColor).not.toBe(
      "#2f9e44",
    );
  });

  it("moves the label with its shape, and rotates in degrees", async () => {
    await callTool("add-elements", {
      elements: [{ type: "rectangle", width: 200, height: 100, label: "Hi" }],
      position: { x: 0, y: 0 },
    });
    const box = sceneElements().find((e) => e.type === "rectangle")!;
    const label = sceneElements().find((e) => e.type === "text")!;
    const offset = { x: label.x - box.x, y: label.y - box.y };
    await callTool("update-elements", {
      updates: [{ id: box.id, x: 500, y: 300, angle: 45 }],
    });
    const movedBox = h.elements.find((e) => e.id === box.id)!;
    const movedLabel = h.elements.find((e) => e.id === label.id)!;
    expect(movedBox.angle).toBeCloseTo(Math.PI / 4);
    expect(movedBox.x).toBe(500);
    expect(movedLabel.x - movedBox.x).toBeCloseTo(offset.x);
    expect(movedLabel.y - movedBox.y).toBeCloseTo(offset.y);
  });

  it("edits text and labels, and gives an unlabeled shape its first label", async () => {
    await callTool("add-elements", {
      elements: [
        { type: "text", text: "old" },
        { type: "rectangle", label: "box", y: 100 },
        { type: "ellipse", y: 300, width: 160, height: 100 },
      ],
      position: { x: 0, y: 0 },
    });
    const [text, rect, ellipse] = sceneElements().filter(
      (e) => !(e.type === "text" && e.containerId),
    );
    expectOk(
      await callTool("update-elements", {
        updates: [
          { id: text.id, text: "new text", fontSize: 36, fontFamily: "Nunito" },
          { id: rect.id, text: "renamed", textColor: "#e03131" },
          { id: ellipse.id, text: "fresh label" },
        ],
      }),
    );
    expect(h.elements.find((e) => e.id === text.id)).toMatchObject({
      text: "new text",
      fontSize: 36,
    });
    const labels = sceneElements().filter(
      (e) => e.type === "text" && e.containerId,
    );
    expect(
      labels.map((l: any) => [l.containerId, l.text, l.strokeColor]),
    ).toEqual(
      expect.arrayContaining([
        [rect.id, "renamed", "#e03131"],
        [ellipse.id, "fresh label", expect.any(String)],
      ]),
    );
    expect(
      h.elements.find((e) => e.id === ellipse.id)!.boundElements,
    ).toHaveLength(1);

    const listed = expectOk(
      await callTool("get-elements", { ids: [ellipse.id] }),
    );
    expect(listed.elements[0].text).toBe("fresh label");
  });

  it("renames frames, sets links, locks and unlocks", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    const { frame } = expectOk(
      await callTool("wrap-in-frame", { ids: [a.id] }),
    );
    await callTool("update-elements", {
      updates: [
        { id: frame.id, name: "Intro" },
        { id: a.id, link: "https://example.com/x", locked: true },
      ],
    });
    expect((h.elements.find((e) => e.id === frame.id) as any).name).toBe(
      "Intro",
    );
    expect(h.elements.find((e) => e.id === a.id)).toMatchObject({
      link: "https://example.com/x",
      locked: true,
    });
    // locked elements are protected until unlocked
    expect(
      expectError(
        await callTool("update-elements", {
          updates: [{ id: a.id, strokeColor: "#000000" }],
        }),
        "invalid-input",
      ),
    ).toContain("locked");
    expectOk(
      await callTool("update-elements", {
        updates: [{ id: a.id, locked: false }],
      }),
    );
    expectOk(
      await callTool("update-elements", {
        updates: [{ id: a.id, link: null }],
      }),
    );
    expect(h.elements.find((e) => e.id === a.id)!.link).toBeNull();
  });

  it("changes nothing when any update is invalid", async () => {
    const [a, b] = await addBoxes({ a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    const stack = API.getUndoStack().length;
    expectError(
      await callTool("update-elements", {
        updates: [
          { id: a.id, strokeColor: "#e03131" },
          { id: b.id, link: `${"java"}script:alert(1)` },
        ],
      }),
      "invalid-input",
    );
    expect(h.elements.find((e) => e.id === a.id)!.strokeColor).not.toBe(
      "#e03131",
    );
    expect(API.getUndoStack()).toHaveLength(stack);
  });

  it.each([
    [(id: string) => ({ updates: [{ id }] }), "nothing to change"],
    [(id: string) => ({ updates: [{ id, width: 0 }] }), "width"],
    [
      (id: string) => ({ updates: [{ id, strokeColor: `${"java"}script:1` }] }),
      "strokeColor",
    ],
    [
      (id: string) => ({ updates: [{ id, fontFamily: "Comic Sans" }] }),
      "fontFamily",
    ],
    [(id: string) => ({ updates: [{ id, name: "not a frame" }] }), "frames"],
    [
      (id: string) => ({ updates: [{ id, link: "ftp://example.com" }] }),
      "link",
    ],
    [(id: string) => ({ updates: [{ id, text: "x" }] }), null],
  ])("rejects bad updates (%#)", async (build, fragment) => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    const result = await callTool("update-elements", build(a.id) as any);
    if (fragment === null) {
      // a rectangle can take a label
      expectOk(result);
    } else {
      expect(expectError(result, "invalid-input").toLowerCase()).toContain(
        fragment.toLowerCase(),
      );
    }
  });

  it("explains that sizes follow content for text and lines", async () => {
    await callTool("add-elements", {
      elements: [
        { type: "text", text: "t" },
        { type: "line", width: 50 },
      ],
    });
    for (const element of sceneElements()) {
      const message = expectError(
        await callTool("update-elements", {
          updates: [{ id: element.id, width: 300 }],
        }),
        "invalid-input",
      );
      expect(message).toContain(element.type);
    }
  });
});

describe("move-elements and delete-elements", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("moves by an offset, with labels and frame contents", async () => {
    await callTool("add-elements", {
      elements: [
        { type: "rectangle", id: "a", width: 100, height: 60, label: "A" },
        { type: "frame", name: "F", children: ["a"] },
      ],
      position: { x: 0, y: 0 },
    });
    const frame = sceneElements().find((e) => e.type === "frame")!;
    const box = sceneElements().find((e) => e.type === "rectangle")!;
    const label = sceneElements().find((e) => e.type === "text")!;
    const before = [frame, box, label].map((e) => [e.x, e.y]);

    expectOk(
      await callTool("move-elements", { ids: [frame.id], dx: 30, dy: -20 }),
    );
    const after = [frame, box, label].map((e) => {
      const live = h.elements.find((x) => x.id === e.id)!;
      return [live.x, live.y];
    });
    expect(after).toEqual(before.map(([x, y]) => [x + 30, y - 20]));
    expect(API.getUndoStack()).toHaveLength(2);
  });

  it("leaves alone an arrow attached to something that stays", async () => {
    const [a, b] = await addBoxes({ a: { x: 0, y: 0 }, b: { x: 400, y: 0 } });
    const { arrow } = expectOk(
      await callTool("connect-elements", { from: a.id, to: b.id }),
    );
    const result = expectOk(
      await callTool("move-elements", { ids: [arrow.id], dx: 0, dy: 100 }),
    );
    expect(result.notMoved).toEqual([arrow.id]);
    expect(result.moved).toEqual([]);
  });

  it("needs a real offset", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    expectError(
      await callTool("move-elements", { ids: [a.id] }),
      "invalid-input",
    );
  });

  it("deletes elements with their labels, undoably", async () => {
    await callTool("add-elements", {
      elements: [
        { type: "rectangle", label: "A" },
        { type: "ellipse", x: 200 },
      ],
    });
    const rect = sceneElements().find((e) => e.type === "rectangle")!;
    expectOk(await callTool("delete-elements", { ids: [rect.id] }));
    expect(sceneElements().map((e) => e.type)).toEqual(["ellipse"]);

    await callTool("undo");
    expect(
      sceneElements()
        .map((e) => e.type)
        .sort(),
    ).toEqual(["ellipse", "rectangle", "text"]);
  });

  it("keeps a frame's contents when the frame is deleted", async () => {
    const [a, b] = await addBoxes({ a: { x: 0, y: 0 }, b: { x: 300, y: 0 } });
    const { frame } = expectOk(
      await callTool("wrap-in-frame", { ids: [a.id, b.id], name: "Temp" }),
    );
    expectOk(await callTool("delete-elements", { ids: [frame.id] }));
    expect(sceneElements().map((e) => e.id)).toEqual([a.id, b.id]);
    expect(sceneElements().every((e) => e.frameId === null)).toBe(true);
  });

  it("detaches arrows from deleted shapes", async () => {
    const [a, b] = await addBoxes({ a: { x: 0, y: 0 }, b: { x: 400, y: 0 } });
    const { arrow } = expectOk(
      await callTool("connect-elements", { from: a.id, to: b.id }),
    );
    await callTool("delete-elements", { ids: [b.id] });
    const survivor = h.elements.find((e) => e.id === arrow.id) as any;
    expect(survivor.isDeleted).toBe(false);
    expect(survivor.endBinding).toBeNull();
    expect(survivor.startBinding?.elementId).toBe(a.id);
  });

  it("won't touch locked elements or unknown ids", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    await callTool("update-elements", {
      updates: [{ id: a.id, locked: true }],
    });
    expectError(
      await callTool("delete-elements", { ids: [a.id] }),
      "invalid-input",
    );
    expectError(
      await callTool("delete-elements", { ids: ["missing"] }),
      "not-found",
    );
    expectError(
      await callTool("delete-elements", { ids: [] }),
      "invalid-input",
    );
  });
});

describe("duplicate-elements", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("copies with labels and keeps the arrows between copied shapes", async () => {
    const result = expectOk(
      await callTool("create-diagram", {
        nodes: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        edges: [{ from: "a", to: "b" }],
      }),
    );
    const ids = result.created.map((e: any) => e.id);
    const { copies } = expectOk(
      await callTool("duplicate-elements", { ids, dx: 500, dy: 0 }),
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]).toHaveLength(3);
    const copiedArrow = copies[0].find((e: any) => e.type === "arrow");
    const copiedNodes = copies[0].filter((e: any) => e.type !== "arrow");
    expect(copiedArrow.from).toBe(copiedNodes[0].id);
    expect(copiedArrow.to).toBe(copiedNodes[1].id);
    expect(copiedNodes[0].id).not.toBe(ids[0]);
    expect(sceneElements().filter((e) => e.type === "text")).toHaveLength(4);
  });

  it("lays out several copies", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    const { copies } = expectOk(
      await callTool("duplicate-elements", {
        ids: [a.id],
        dx: 150,
        dy: 0,
        count: 3,
      }),
    );
    expect(copies.map((c: any) => c[0].x)).toEqual([
      a.x + 150,
      a.x + 300,
      a.x + 450,
    ]);
    expect(sceneElements()).toHaveLength(4);
    expect(API.getUndoStack()).toHaveLength(2);
  });

  it("limits the number of copies", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    expectError(
      await callTool("duplicate-elements", { ids: [a.id], count: 50 }),
      "invalid-input",
    );
  });
});

describe("arranging tools", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  const positions = (ids: string[]) =>
    ids.map((id) => {
      const element = h.elements.find((e) => e.id === id)!;
      return {
        x: element.x,
        y: element.y,
        w: element.width,
        h: element.height,
      };
    });

  it.each([
    ["left", (p: any) => p.x],
    ["right", (p: any) => p.x + p.w],
    ["top", (p: any) => p.y],
    ["bottom", (p: any) => p.y + p.h],
    ["center-horizontally", (p: any) => p.x + p.w / 2],
    ["center-vertically", (p: any) => p.y + p.h / 2],
  ])("aligns %s", async (alignment, edge) => {
    const [a, b, c] = await addBoxes({
      a: { x: 0, y: 0 },
      b: { x: 150, y: 90 },
      c: { x: 330, y: 20 },
    });
    expectOk(
      await callTool("align-elements", { ids: [a.id, b.id, c.id], alignment }),
    );
    const edges = positions([a.id, b.id, c.id]).map(edge);
    expect(new Set(edges.map((e) => Math.round(e))).size).toBe(1);
    expect(API.getUndoStack()).toHaveLength(2);
  });

  it("distributes evenly", async () => {
    const [a, b, c, d] = await addBoxes({
      a: { x: 0, y: 0 },
      b: { x: 130, y: 0 },
      c: { x: 190, y: 0 },
      d: { x: 600, y: 0 },
    });
    expectOk(
      await callTool("distribute-elements", {
        ids: [a.id, b.id, c.id, d.id],
        axis: "horizontal",
      }),
    );
    const [pa, pb, pc, pd] = positions([a.id, b.id, c.id, d.id]);
    const gaps = [
      pb.x - (pa.x + pa.w),
      pc.x - (pb.x + pb.w),
      pd.x - (pc.x + pc.w),
    ];
    expect(gaps[0]).toBeCloseTo(gaps[1]);
    expect(gaps[1]).toBeCloseTo(gaps[2]);
    expect(pa.x).toBe(0);
    expect(pd.x).toBe(600);
  });

  it("says what each arrangement needs", async () => {
    const [a, b] = await addBoxes({ a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    expect(
      expectError(
        await callTool("align-elements", { ids: [a.id], alignment: "left" }),
        "invalid-input",
      ),
    ).toContain("at least two");
    expect(
      expectError(
        await callTool("distribute-elements", {
          ids: [a.id, b.id],
          axis: "vertical",
        }),
        "invalid-input",
      ),
    ).toContain("three");
    expectError(
      await callTool("align-elements", {
        ids: [a.id, b.id],
        alignment: "diagonal",
      }),
      "invalid-input",
    );
  });

  it("groups and ungroups", async () => {
    const [a, b, c] = await addBoxes({
      a: { x: 0, y: 0 },
      b: { x: 200, y: 0 },
      c: { x: 400, y: 0 },
    });
    const { groupId } = expectOk(
      await callTool("group-elements", { ids: [a.id, b.id] }),
    );
    expect(groupId).toEqual(expect.any(String));
    const grouped = (id: string) =>
      h.elements.find((e) => e.id === id)!.groupIds;
    expect(grouped(a.id)).toEqual([groupId]);
    expect(grouped(b.id)).toEqual([groupId]);
    expect(grouped(c.id)).toEqual([]);

    // a group moves as one under align
    expectOk(
      await callTool("align-elements", {
        ids: [a.id, c.id],
        alignment: "bottom",
      }),
    );

    expectOk(await callTool("ungroup-elements", { ids: [a.id] }));
    expect(grouped(a.id)).toEqual([]);
    expect(grouped(b.id)).toEqual([]);
    expectError(
      await callTool("ungroup-elements", { ids: [c.id] }),
      "invalid-input",
    );
    expectError(
      await callTool("group-elements", { ids: [c.id] }),
      "invalid-input",
    );
  });

  it("reorders the stacking", async () => {
    const [a, b, c] = await addBoxes({
      a: { x: 0, y: 0 },
      b: { x: 20, y: 0 },
      c: { x: 40, y: 0 },
    });
    const order = () => sceneElements().map((e) => e.id);
    expect(order()).toEqual([a.id, b.id, c.id]);
    await callTool("reorder-elements", {
      ids: [a.id],
      order: "bring-to-front",
    });
    expect(order()).toEqual([b.id, c.id, a.id]);
    await callTool("reorder-elements", { ids: [a.id], order: "send-backward" });
    expect(order()).toEqual([b.id, a.id, c.id]);
    await callTool("reorder-elements", { ids: [a.id], order: "send-to-back" });
    expect(order()).toEqual([a.id, b.id, c.id]);
    await callTool("reorder-elements", { ids: [a.id], order: "bring-forward" });
    expect(order()).toEqual([b.id, a.id, c.id]);
    expectError(
      await callTool("reorder-elements", { ids: [a.id], order: "sideways" }),
      "invalid-input",
    );
  });

  it("wraps elements in a titled frame", async () => {
    const [a, b] = await addBoxes({ a: { x: 0, y: 0 }, b: { x: 200, y: 100 } });
    const { frame } = expectOk(
      await callTool("wrap-in-frame", { ids: [a.id, b.id], name: "Backend" }),
    );
    expect(frame).toMatchObject({ type: "frame", name: "Backend" });
    expect(frame.x).toBeLessThan(0);
    expect(frame.x + frame.width).toBeGreaterThan(300);
    expect(h.elements.find((e) => e.id === a.id)!.frameId).toBe(frame.id);
    expect(h.elements.find((e) => e.id === b.id)!.frameId).toBe(frame.id);
    expectError(
      await callTool("wrap-in-frame", { ids: [frame.id] }),
      "invalid-input",
    );
  });
});

describe("view tools", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("selects, adds to and removes from the selection", async () => {
    const [a, b, c] = await addBoxes({
      a: { x: 0, y: 0 },
      b: { x: 200, y: 0 },
      c: { x: 400, y: 0 },
    });
    const selected = () => Object.keys(h.state.selectedElementIds).sort();
    await callTool("select-elements", { ids: [a.id] });
    expect(selected()).toEqual([a.id]);
    await callTool("select-elements", { ids: [b.id], mode: "add" });
    expect(selected()).toEqual([a.id, b.id].sort());
    await callTool("select-elements", { ids: [a.id], mode: "remove" });
    expect(selected()).toEqual([b.id]);
    await callTool("select-elements", { ids: [] });
    expect(selected()).toEqual([]);
    expectError(
      await callTool("select-elements", { ids: ["gone"] }),
      "not-found",
    );
    expectError(await callTool("select-elements", {}), "invalid-input");
    expect(c.id).toBeTruthy();
  });

  it("selects whole groups", async () => {
    const [a, b] = await addBoxes({ a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    await callTool("group-elements", { ids: [a.id, b.id] });
    await callTool("select-elements", { ids: [] });
    await callTool("select-elements", { ids: [a.id] });
    expect(Object.keys(h.state.selectedElementIds).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });

  it("brings elements into view", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    await callTool("add-elements", {
      elements: [{ type: "rectangle", width: 100, height: 100 }],
      position: { x: 20000, y: 20000 },
      reveal: false,
      select: false,
    });
    const far = sceneElements().find((e) => e.x === 20000)!;
    const centerX = () =>
      -h.state.scrollX + h.state.width / h.state.zoom.value / 2;
    expect(Math.abs(centerX() - far.x)).toBeGreaterThan(10000);

    expectOk(await callTool("focus-viewport", { ids: [far.id], fit: "none" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    // the view moved over to the element
    expect(Math.abs(centerX() - (far.x + 50))).toBeLessThanOrEqual(
      h.state.width / h.state.zoom.value,
    );
    expect(a.id).toBeTruthy();
  });

  it("can't focus on nothing", async () => {
    expectError(await callTool("focus-viewport"), "not-found");
  });

  it("configures the canvas", async () => {
    expectOk(
      await callTool("configure-canvas", {
        theme: "dark",
        backgroundColor: "#1e1e1e",
        grid: true,
        name: "Roadmap",
      }),
    );
    expect(h.state).toMatchObject({
      theme: "dark",
      viewBackgroundColor: "#1e1e1e",
      gridModeEnabled: true,
      name: "Roadmap",
    });
    expectError(await callTool("configure-canvas", {}), "invalid-input");
    expectError(
      await callTool("configure-canvas", { theme: "sepia" }),
      "invalid-input",
    );
    expectError(
      await callTool("configure-canvas", { backgroundColor: "nope!" }),
      "invalid-input",
    );
  });

  it("undoes and redoes, reporting when there is nothing to do", async () => {
    expect(expectOk(await callTool("undo")).changed).toBe(false);

    await addBoxes({ a: { x: 0, y: 0 } });
    expect(sceneElements()).toHaveLength(1);
    expect(expectOk(await callTool("undo")).changed).toBe(true);
    expect(sceneElements()).toHaveLength(0);
    expect(expectOk(await callTool("redo")).changed).toBe(true);
    expect(sceneElements()).toHaveLength(1);
    const result = expectOk(await callTool("redo"));
    expect(result.changed).toBe(false);
    expect(result.note).toContain("nothing to redo");
  });

  it("undoes the user's changes too", async () => {
    API.setElements([API.createElement({ type: "rectangle", x: 0, y: 0 })]);
    API.updateScene({
      elements: [
        ...h.elements,
        API.createElement({ type: "ellipse", x: 200, y: 0 }),
      ],
      captureUpdate: "IMMEDIATELY" as any,
    });
    await callTool("undo");
    expect(sceneElements().map((e) => e.type)).toEqual(["rectangle"]);
  });

  it("clears the canvas, undoably", async () => {
    expectError(await callTool("clear-canvas"), "invalid-input");
    await addBoxes({ a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    expect(expectOk(await callTool("clear-canvas")).deleted).toBe(2);
    expect(sceneElements()).toHaveLength(0);
    await callTool("undo");
    expect(sceneElements()).toHaveLength(2);
  });
});

describe("host settings", () => {
  it("clear-canvas respects a host that disabled clearing the canvas", async () => {
    await render(
      <Excalidraw
        webMCP
        UIOptions={{ canvasActions: { clearCanvas: false } }}
      />,
    );
    await act(async () => {});
    await addBoxes({ a: { x: 0, y: 0 } });
    expectError(await callTool("clear-canvas"), "invalid-input");
    expect(sceneElements()).toHaveLength(1);
  });
});

describe("add-mermaid-diagram", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("rejects Mermaid that doesn't parse, with the parser's message", async () => {
    const message = expectError(
      await callTool("add-mermaid-diagram", {
        mermaid: "flowchart TD\n  A --> ",
      }),
      "invalid-input",
    );
    expect(message).toContain("couldn't be parsed");
    expect(sceneElements()).toHaveLength(0);
  });

  it("requires the mermaid source", async () => {
    expectError(await callTool("add-mermaid-diagram", {}), "invalid-input");
  });
});

describe("capture-image", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("has nothing to capture on an empty canvas", async () => {
    expectError(await callTool("capture-image"), "not-found");
  });

  it("renders SVG of everything, the selection, or given elements", async () => {
    const [a, b] = await addBoxes({
      a: { x: 0, y: 0, label: "Alpha" },
      b: { x: 300, y: 0, label: "Beta" },
    });
    const all = expectOk(await callTool("capture-image", { format: "svg" }));
    expect(all.mimeType).toBe("image/svg+xml");
    expect(all.svg).toMatch(/^<svg/);

    await callTool("select-elements", { ids: [a.id] });
    const selected = expectOk(
      await callTool("capture-image", { format: "svg", selectedOnly: true }),
    );
    const named = expectOk(
      await callTool("capture-image", { format: "svg", ids: [b.id] }),
    );
    expect(selected.svg).not.toEqual(named.svg);
    expect(selected.svg.length).toBeLessThan(all.svg.length);

    await callTool("select-elements", { ids: [] });
    expectError(
      await callTool("capture-image", { selectedOnly: true }),
      "not-found",
    );
  });

  it("renders a PNG data URL", async () => {
    await addBoxes({ a: { x: 0, y: 0 } });
    const result = expectOk(await callTool("capture-image", { maxSize: 256 }));
    expect(result.mimeType).toBe("image/png");
    expect(result.dataURL).toMatch(/^data:image\/png;base64,/);
  });

  it("validates its options", async () => {
    await addBoxes({ a: { x: 0, y: 0 } });
    expectError(
      await callTool("capture-image", { format: "gif" }),
      "invalid-input",
    );
    expectError(
      await callTool("capture-image", { maxSize: 100000 }),
      "invalid-input",
    );
    expectError(
      await callTool("capture-image", { theme: "sepia" }),
      "invalid-input",
    );
  });
});

describe("library tools", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  const saveToLibrary = async (name: string, elements: any[]) => {
    await act(async () => {
      await h.app.library.updateLibrary({
        libraryItems: [
          {
            id: `item-${name}`,
            status: "unpublished",
            created: Date.now(),
            name,
            elements,
          },
        ],
        merge: true,
      });
    });
  };

  it("lists and filters the user's library", async () => {
    expect(expectOk(await callTool("list-library-items")).items).toEqual([]);
    await saveToLibrary("Login form", [
      API.createElement({ type: "rectangle", width: 200, height: 100 }),
    ]);
    await saveToLibrary("Database", [
      API.createElement({ type: "ellipse", width: 80, height: 80 }),
      API.createElement({ type: "ellipse", x: 100, width: 80, height: 80 }),
    ]);
    const all = expectOk(await callTool("list-library-items"));
    expect(all.total).toBe(2);
    expect(all.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "item-Database",
          name: "Database",
          elementCount: 2,
        }),
      ]),
    );
    const filtered = expectOk(
      await callTool("list-library-items", { nameContains: "LOGIN" }),
    );
    expect(filtered.items.map((i: any) => i.name)).toEqual(["Login form"]);
  });

  it("inserts an item as new elements, repeatedly", async () => {
    await saveToLibrary("Pair", [
      API.createElement({
        type: "rectangle",
        x: 10,
        y: 10,
        width: 100,
        height: 50,
      }),
      API.createElement({
        type: "ellipse",
        x: 200,
        y: 10,
        width: 50,
        height: 50,
      }),
    ]);
    const first = expectOk(
      await callTool("insert-library-item", {
        id: "item-Pair",
        position: { x: 1000, y: 500 },
      }),
    );
    expect(first.created.map((e: any) => [e.type, e.x, e.y])).toEqual([
      ["rectangle", 1000, 500],
      ["ellipse", 1190, 500],
    ]);
    const second = expectOk(
      await callTool("insert-library-item", { id: "item-Pair" }),
    );
    expect(sceneElements()).toHaveLength(4);
    // each insertion is a fresh copy
    const ids = [...first.created, ...second.created].map((e: any) => e.id);
    expect(new Set(ids).size).toBe(4);
    expect(API.getUndoStack()).toHaveLength(2);
  });

  it("explains an unknown item", async () => {
    expect(
      expectError(
        await callTool("insert-library-item", { id: "nope" }),
        "not-found",
      ),
    ).toContain("list-library-items");
  });
});

describe("hardening", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it.each([
    [
      "add-elements",
      { elements: [{ type: "rectangle", x: 1e300, width: 1e308 }] },
      "elements[0].x",
    ],
    [
      "add-elements",
      { elements: [{ type: "rectangle" }], position: { x: 1e308, y: 0 } },
      "position.x",
    ],
    [
      "add-elements",
      { elements: [{ type: "rectangle", width: 1e9 }] },
      "elements[0].width",
    ],
  ])("rejects out-of-range numbers (%#)", async (name, input, parameter) => {
    const message = expectError(
      await callTool(name, input as any),
      "invalid-input",
    );
    expect(message).toContain(parameter);
    expect(sceneElements()).toHaveLength(0);
  });

  it("rejects out-of-range moves, positions and angles", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    expectError(
      await callTool("move-elements", { ids: [a.id], dx: 1e308 }),
      "invalid-input",
    );
    expectError(
      await callTool("update-elements", { updates: [{ id: a.id, x: 1e300 }] }),
      "invalid-input",
    );
    expectError(
      await callTool("update-elements", {
        updates: [{ id: a.id, angle: 1e12 }],
      }),
      "invalid-input",
    );
    expect(h.elements.find((e) => e.id === a.id)!.x).toBe(a.x);
  });

  it("places new content sensibly even if the drawing holds broken geometry", async () => {
    API.setElements([
      API.createElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: Infinity as number,
      }),
    ]);
    const { created } = expectOk(
      await callTool("add-elements", { elements: [{ type: "rectangle" }] }),
    );
    expect(Number.isFinite(created[0].x)).toBe(true);
  });

  it("keeps frames from containing frames, or themselves", async () => {
    for (const elements of [
      [{ type: "frame", id: "self", children: ["self"] }],
      [
        { type: "frame", id: "f1", children: ["f2"] },
        { type: "frame", id: "f2", children: ["f1"] },
      ],
    ]) {
      expect(
        expectError(
          await callTool("add-elements", { elements }),
          "invalid-input",
        ),
      ).toContain("can't be nested");
    }
    expect(sceneElements()).toHaveLength(0);
  });

  it("holds writes while the user is in the middle of an interaction, not reads", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    act(() => h.setState({ selectedElementsAreBeingDragged: true }));
    expect(
      expectError(
        await callTool("update-elements", {
          updates: [{ id: a.id, text: "x" }],
        }),
        "busy",
      ),
    ).toContain("Wait");
    expectOk(await callTool("get-elements"));
    act(() => h.setState({ selectedElementsAreBeingDragged: false }));
    expectOk(
      await callTool("update-elements", { updates: [{ id: a.id, text: "x" }] }),
    );
  });

  it("moves the view and the selection in view mode, but changes nothing", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    act(() => h.setState({ viewModeEnabled: true }));
    expectOk(await callTool("select-elements", { ids: [a.id] }));
    expectOk(await callTool("focus-viewport"));
    expectError(
      await callTool("delete-elements", { ids: [a.id] }),
      "view-mode",
    );
  });

  it("includes labels when capturing given or selected elements", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0, label: "Alpha" } });
    for (const input of [{ ids: [a.id] }, { selectedOnly: true }]) {
      await callTool("select-elements", { ids: [a.id] });
      const { svg } = expectOk(
        await callTool("capture-image", { format: "svg", ...input }),
      );
      expect(svg).toContain("Alpha");
    }
    expectError(
      await callTool("capture-image", { ids: [a.id], selectedOnly: true }),
      "invalid-input",
    );
  });

  it("refuses font and color changes that have nothing to apply to", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0 } });
    const stack = API.getUndoStack().length;
    for (const patch of [{ fontSize: 30 }, { textColor: "#e03131" }]) {
      expect(
        expectError(
          await callTool("update-elements", {
            updates: [{ id: a.id, ...patch }],
          }),
          "invalid-input",
        ),
      ).toContain("no");
    }
    expect(API.getUndoStack()).toHaveLength(stack);
    // with a label to apply them to, they work
    expectOk(
      await callTool("update-elements", {
        updates: [{ id: a.id, text: "hi", fontSize: 30 }],
      }),
    );
  });

  it("rejects empty text and labels", async () => {
    expectError(
      await callTool("add-elements", {
        elements: [{ type: "text", text: "  " }],
      }),
      "invalid-input",
    );
    expectError(
      await callTool("create-diagram", { nodes: [{ id: "a", label: "" }] }),
      "invalid-input",
    );
  });

  it("validates expectedSceneVersion", async () => {
    for (const expectedSceneVersion of ["x", 1.5]) {
      expectError(
        await callTool("undo", { expectedSceneVersion }),
        "invalid-input",
      );
    }
  });

  it("counts what clear-canvas deleted like get-canvas-info does", async () => {
    await addBoxes({
      a: { x: 0, y: 0, label: "A" },
      b: { x: 200, y: 0, label: "B" },
    });
    const { elementCount } = expectOk(await callTool("get-canvas-info"));
    expect(expectOk(await callTool("clear-canvas")).deleted).toBe(elementCount);
  });
});

describe("review follow-ups", () => {
  beforeEach(async () => {
    await renderEditor();
  });

  it("rejects unknown parameters instead of ignoring typos", async () => {
    expect(
      expectError(
        await callTool("add-elements", {
          elements: [{ type: "rectangle", colour: "red" }],
        }),
        "invalid-input",
      ),
    ).toContain('"elements[0].colour"');
    expect(
      expectError(
        await callTool("get-elements", { bogus: 1 }),
        "invalid-input",
      ),
    ).toContain('"bogus"');
    expect(sceneElements()).toHaveLength(0);
  });

  it("takes elements moved out of a frame out of it", async () => {
    const [a] = await addBoxes({ a: { x: 0, y: 0, label: "A" } });
    const { frame } = expectOk(
      await callTool("wrap-in-frame", { ids: [a.id] }),
    );
    const frameOf = (id: string) =>
      h.elements.find((e) => e.id === id)!.frameId;
    expect(frameOf(a.id)).toBe(frame.id);

    // a small move keeps it
    expectOk(await callTool("move-elements", { ids: [a.id], dx: 5 }));
    expect(frameOf(a.id)).toBe(frame.id);

    expectOk(await callTool("move-elements", { ids: [a.id], dx: 3000 }));
    expect(frameOf(a.id)).toBeNull();
    // and so is its label
    expect(sceneElements().find((e) => e.type === "text")!.frameId).toBeNull();
  });

  it("won't blank a label or text, or rotate an arrow", async () => {
    const [a, b] = await addBoxes({
      a: { x: 0, y: 0, label: "A" },
      b: { x: 300, y: 0 },
    });
    expect(
      expectError(
        await callTool("update-elements", {
          updates: [{ id: a.id, text: "" }],
        }),
        "invalid-input",
      ),
    ).toContain("delete-elements");
    const { arrow } = expectOk(
      await callTool("connect-elements", { from: a.id, to: b.id }),
    );
    expectError(
      await callTool("update-elements", {
        updates: [{ id: arrow.id, angle: 30 }],
      }),
      "invalid-input",
    );
  });

  it("gives a new label its container's groups", async () => {
    const [a, b] = await addBoxes({ a: { x: 0, y: 0 }, b: { x: 300, y: 0 } });
    const { groupId } = expectOk(
      await callTool("group-elements", { ids: [a.id, b.id] }),
    );
    await callTool("update-elements", {
      updates: [{ id: a.id, text: "label" }],
    });
    const label = sceneElements().find((e) => e.type === "text")!;
    expect(label.groupIds).toEqual([groupId]);
  });

  it("reports an undo that only changed the background", async () => {
    await callTool("configure-canvas", { backgroundColor: "#ffc9c9" });
    const result = expectOk(await callTool("undo"));
    expect(result.changed).toBe(true);
    expect(h.state.viewBackgroundColor).not.toBe("#ffc9c9");
  });

  it("flags the tools that return existing user content as untrusted", () => {
    for (const name of [
      "get-canvas-info",
      "update-elements",
      "move-elements",
      "duplicate-elements",
      "connect-elements",
    ]) {
      expect(
        ALL_TOOLS.find((t) => t.name === name)!.annotations
          .untrustedContentHint,
      ).toBe(true);
    }
  });
});

describe("configure-canvas and host settings", () => {
  it("honors the host's UIOptions and controlled theme", async () => {
    await render(
      <Excalidraw
        webMCP
        theme="dark"
        UIOptions={{
          canvasActions: {
            toggleTheme: false,
            changeViewBackgroundColor: false,
          },
        }}
      />,
    );
    await act(async () => {});
    expectError(
      await callTool("configure-canvas", { theme: "light" }),
      "invalid-input",
    );
    expectError(
      await callTool("configure-canvas", { backgroundColor: "#00ff00" }),
      "invalid-input",
    );
    expect(h.state.theme).toBe("dark");
    expectOk(await callTool("configure-canvas", { grid: true }));
  });
});

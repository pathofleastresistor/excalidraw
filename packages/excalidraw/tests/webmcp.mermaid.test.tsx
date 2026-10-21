import { Excalidraw } from "../index";

import { mockMermaidToExcalidraw } from "./helpers/mocks";
import {
  callTool,
  expectError,
  expectOk,
  installModelContext,
  renderEditorElement,
  sceneElements,
  uninstallModelContext,
} from "./helpers/webmcp";

import { API } from "./helpers/api";

const { h } = window;

mockMermaidToExcalidraw({
  mockRef: true,
  parseMermaidToExcalidraw: async (definition) => {
    if (!definition.startsWith("flowchart")) {
      throw new Error("Parse error on line 1");
    }
    return {
      elements: [
        {
          type: "rectangle",
          id: "A",
          x: 0,
          y: 0,
          width: 120,
          height: 50,
          label: { text: "Start" },
        },
        {
          type: "rectangle",
          id: "B",
          x: 0,
          y: 150,
          width: 120,
          height: 50,
          label: { text: "End" },
        },
        {
          type: "arrow",
          x: 60,
          y: 50,
          width: 0,
          height: 100,
          start: { id: "A" },
          end: { id: "B" },
        },
      ],
      files: {},
    };
  },
});

beforeEach(() => {
  installModelContext();
});

afterEach(() => {
  uninstallModelContext();
});

describe("add-mermaid-diagram", () => {
  beforeEach(async () => {
    await renderEditorElement(<Excalidraw webMCP />);
  });

  it("draws the diagram as editable elements, in one undo step", async () => {
    const result = expectOk(
      await callTool("add-mermaid-diagram", {
        mermaid: "flowchart TD\n  A[Start] --> B[End]",
        position: { x: 500, y: 300 },
      }),
    );
    const byText = (text: string) =>
      result.created.find((e: any) => e.text === text);
    expect(byText("Start")).toMatchObject({
      type: "rectangle",
      x: 500,
      y: 300,
    });
    expect(byText("End")).toMatchObject({ type: "rectangle", x: 500, y: 450 });
    const arrow = result.created.find((e: any) => e.type === "arrow");
    expect(arrow).toMatchObject({
      from: byText("Start").id,
      to: byText("End").id,
    });
    expect(API.getUndoStack()).toHaveLength(1);
    expect(h.state.selectedElementIds).not.toEqual({});

    await callTool("undo");
    expect(sceneElements()).toHaveLength(0);
  });

  it("reports what the parser rejected", async () => {
    const message = expectError(
      await callTool("add-mermaid-diagram", { mermaid: "nonsense" }),
      "invalid-input",
    );
    expect(message).toContain("Parse error on line 1");
  });
});

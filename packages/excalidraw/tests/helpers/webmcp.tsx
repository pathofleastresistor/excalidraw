import { vi } from "vitest";

import { act, render } from "../test-utils";

import type React from "react";

import type { WebMCPTool } from "../../webmcp/types";

const { h } = window;

/** a stand-in for the browser's `document.modelContext` */
export const createModelContext = () => {
  const tools = new Map<string, WebMCPTool>();
  return {
    tools,
    registerTool: vi.fn(
      async (tool: WebMCPTool, options?: { signal?: AbortSignal }) => {
        if (tools.has(tool.name)) {
          throw new Error(`duplicate tool name "${tool.name}"`);
        }
        tools.set(tool.name, tool);
        options?.signal?.addEventListener("abort", () => {
          tools.delete(tool.name);
        });
      },
    ),
  };
};

let modelContext: ReturnType<typeof createModelContext>;

/** installs a fresh `document.modelContext` for the test */
export const installModelContext = () => {
  modelContext = createModelContext();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: modelContext,
  });
  return modelContext;
};

export const uninstallModelContext = () => {
  delete (document as any).modelContext;
};

/** calls a tool the way a browser agent does: JSON in, JSON out */
export const callTool = async (
  name: string,
  input: Record<string, unknown> = {},
  signal = new AbortController().signal,
) => {
  const tool = modelContext.tools.get(name);
  if (!tool) {
    throw new Error(`tool "${name}" isn't registered`);
  }
  const result = await act(() =>
    tool.execute(JSON.parse(JSON.stringify(input)), { signal }),
  );
  return JSON.parse(JSON.stringify(result)) as Record<string, any>;
};

export const expectOk = (result: Record<string, any>) => {
  expect(result).toMatchObject({ ok: true });
  return result;
};

export const expectError = (result: Record<string, any>, code: string) => {
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe(code);
  expect(result.error.message).toEqual(expect.any(String));
  return result.error.message as string;
};

/** renders the editor and lets its mount effects (tool registration) settle */
export const renderEditorElement = async (ui: React.ReactElement) => {
  const result = await render(ui);
  await act(async () => {});
  return result;
};

export const sceneElements = () =>
  h.elements.filter((element) => !element.isDeleted);

/** adds shapes with the tool and returns their ids by the names given */
export const addBoxes = async (
  boxes: Record<string, { x: number; y: number; label?: string }>,
) => {
  const result = expectOk(
    await callTool("add-elements", {
      elements: Object.entries(boxes).map(([id, box]) => ({
        type: "rectangle",
        id,
        width: 100,
        height: 60,
        ...box,
      })),
      position: { x: 0, y: 0 },
    }),
  );
  return result.created as { id: string; x: number; y: number }[];
};

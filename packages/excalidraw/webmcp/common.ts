import { getSceneVersion } from "@excalidraw/element";

import type App from "../components/App";

import type {
  WebMCPJSONSchema,
  WebMCPTool,
  WebMCPToolAnnotations,
} from "./types";

export type ToolContext = {
  app: App;
};

export type ToolErrorCode =
  | "invalid-input"
  | "not-found"
  | "view-mode"
  | "busy"
  | "scene-changed"
  | "unavailable"
  | "failed";

/**
 * Expected failure of a tool call. It's returned to the agent as data
 * (`{ ok: false, error }`) rather than thrown through WebMCP, which reports a
 * rejected tool to the agent without the reason: the message has to reach it
 * so that it can correct the call and retry.
 */
export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export type ToolResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: { code: ToolErrorCode; message: string } };

export type ToolDefinition = {
  name: string;
  title: string;
  /** keep it short and positive: what the tool does and when to use it */
  description: string;
  inputSchema: WebMCPJSONSchema;
  annotations: WebMCPToolAnnotations;
  /** a tool that only moves the view or the selection works in view mode */
  allowInViewMode?: boolean;
  handler: (
    input: Record<string, unknown>,
    ctx: ToolContext & { signal: AbortSignal },
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
};

// WebMCP guidance for keeping tool metadata and output concise
// (https://developer.chrome.com/docs/ai/webmcp/secure-tools)
export const MAX_NAME_LENGTH = 30;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_PARAMETER_DESCRIPTION_LENGTH = 150;

/** parameters shared by all the tools that change the canvas */
export const EXPECTED_SCENE_VERSION_PROPERTY: Record<string, WebMCPJSONSchema> =
  {
    expectedSceneVersion: {
      type: "integer",
      description:
        "sceneVersion from your last read; the call is refused if the canvas changed since",
    },
  };

export const getCurrentSceneVersion = (app: App) =>
  getSceneVersion(app.scene.getElementsIncludingDeleted());

const toError = (error: unknown): ToolResult => {
  if (error instanceof ToolError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  console.error("[WebMCP] tool failed", error);
  return {
    ok: false,
    error: {
      code: "failed",
      message: `The tool failed unexpectedly: ${
        error instanceof Error ? error.message : String(error)
      }`,
    },
  };
};

/**
 * Wraps a tool definition into a WebMCP tool with the checks every tool
 * needs: the editor is alive, writes are allowed (not in view mode) and
 * aren't based on a stale read, and the call hasn't been cancelled.
 */
export const toWebMCPTool = (
  definition: ToolDefinition,
  getApp: () => App | null,
): WebMCPTool => {
  const isReadOnly = definition.annotations.readOnlyHint === true;

  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: isReadOnly
      ? definition.inputSchema
      : {
          ...definition.inputSchema,
          properties: {
            ...definition.inputSchema.properties,
            ...EXPECTED_SCENE_VERSION_PROPERTY,
          },
        },
    annotations: definition.annotations,
    execute: async (input, { signal }) => {
      try {
        const app = getApp();
        if (!app) {
          throw new ToolError("unavailable", "The editor is no longer open.");
        }
        signal.throwIfAborted();

        if (!isReadOnly) {
          if (app.state.viewModeEnabled && !definition.allowInViewMode) {
            throw new ToolError(
              "view-mode",
              "The canvas is in view mode and can't be changed. Reading is still possible.",
            );
          }
          const { state } = app;
          if (
            state.editingTextElement ||
            state.newElement ||
            state.multiElement ||
            state.resizingElement ||
            state.selectedElementsAreBeingDragged
          ) {
            throw new ToolError(
              "busy",
              "The user is in the middle of editing or drawing. Wait a moment and retry.",
            );
          }
          const expected = input?.expectedSceneVersion;
          if (expected != null && !Number.isInteger(expected)) {
            throw new ToolError(
              "invalid-input",
              '"expectedSceneVersion" must be the integer sceneVersion from a previous result.',
            );
          }
          if (expected != null) {
            const current = getCurrentSceneVersion(app);
            if (expected !== current) {
              throw new ToolError(
                "scene-changed",
                `The canvas changed since you read it (sceneVersion is now ${current}). Read it again, then retry.`,
              );
            }
          }
        }

        const output = await definition.handler(input ?? {}, { app, signal });
        return {
          ok: true,
          ...output,
          sceneVersion: getCurrentSceneVersion(app),
        } as ToolResult;
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        return toError(error);
      }
    },
  };
};

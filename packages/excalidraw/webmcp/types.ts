/**
 * Minimal typings for the WebMCP API (https://webmachinelearning.github.io/webmcp/),
 * which isn't part of TypeScript's DOM lib yet.
 */

export type WebMCPToolAnnotations = {
  /** the tool doesn't modify any state */
  readOnlyHint?: boolean;
  /** the tool's output contains content the site author doesn't control */
  untrustedContentHint?: boolean;
  /** the tool has significant or hard-to-reverse effects */
  consequentialHint?: boolean;
};

export type WebMCPJSONSchema = {
  type?: string | readonly string[];
  description?: string;
  properties?: Record<string, WebMCPJSONSchema>;
  required?: readonly string[];
  items?: WebMCPJSONSchema;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  additionalProperties?: boolean | WebMCPJSONSchema;
  minItems?: number;
  maxItems?: number;
  oneOf?: readonly WebMCPJSONSchema[];
};

export type WebMCPTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: WebMCPJSONSchema;
  annotations?: WebMCPToolAnnotations;
  execute: (
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ) => Promise<unknown>;
};

export type WebMCPRegisterToolOptions = {
  exposedTo?: string[];
  signal?: AbortSignal;
};

export interface WebMCPModelContext {
  registerTool(
    tool: WebMCPTool,
    options?: WebMCPRegisterToolOptions,
  ): Promise<void> | void;
}

/** Options for the editor's WebMCP integration (`<Excalidraw webMCP />`). */
export type WebMCPOptions = {
  /**
   * Origins (of embedding/embedded documents) the tools are exposed to, as
   * in `registerTool`'s `exposedTo`. Defaults to the browser's default
   * (same-origin documents only).
   */
  exposedTo?: string[];
  /**
   * Only expose the tools that read the canvas, not the ones that change it.
   * @default false
   */
  readOnly?: boolean;
};

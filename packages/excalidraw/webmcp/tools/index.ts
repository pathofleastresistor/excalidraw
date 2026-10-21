import { arrangeTools } from "./arrange";
import { createTools } from "./create";
import { editTools } from "./edit";
import { inspectTools } from "./inspect";
import { readTools } from "./read";
import { viewTools } from "./view";

import type { ToolDefinition } from "../common";

/** every tool, with the ones that don't change the canvas first */
export const ALL_TOOLS: readonly ToolDefinition[] = [
  ...readTools,
  ...inspectTools,
  ...createTools,
  ...editTools,
  ...arrangeTools,
  ...viewTools,
];

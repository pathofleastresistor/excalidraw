import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { getSelectionStateForElements } from "../components/App.selection";

import { ToolError } from "./common";

import type { Action } from "../actions/types";
import type { ToolContext } from "./common";

/**
 * Runs one of the editor's own actions (align, group, delete…) on the given
 * elements instead of the user's selection, so that the tools behave exactly
 * as the matching menu entries and shortcuts do. The action sees the targets
 * as the selection; afterwards they stay selected, which shows the user what
 * the agent acted on.
 */
export const runAction = async (
  { app }: ToolContext,
  action: Action,
  targets: readonly NonDeletedExcalidrawElement[],
  opts: { formData?: unknown; notApplicable: string },
) => {
  const elements = app.scene.getElementsIncludingDeleted();
  const appState = {
    ...app.state,
    ...getSelectionStateForElements(
      targets,
      app.scene.getNonDeletedElements(),
      app.state,
    ),
  };

  if (
    action.predicate &&
    !action.predicate(elements, appState, app.props, app)
  ) {
    throw new ToolError("invalid-input", opts.notApplicable);
  }

  const result = await action.perform(
    elements,
    appState,
    opts.formData ?? null,
    app,
  );
  if (!result) {
    throw new ToolError("failed", "The editor declined the change.");
  }
  app.syncActionResult(result);
};

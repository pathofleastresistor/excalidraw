import { pointFrom } from "@excalidraw/math";

import {
  bindBindingElement,
  getCommonBounds,
  isElbowArrow,
  isFrameLikeElement,
  updateBoundElements,
} from "@excalidraw/element";

import { CaptureUpdateAction } from "@excalidraw/element";

import type {
  ExcalidrawArrowElement,
  ExcalidrawBindableElement,
  ExcalidrawElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { ToolError } from "./common";

import type { ToolContext } from "./common";

/** space left between existing content and what's added next to it */
const PLACEMENT_GAP = 80;

export const getVisibleElements = ({ app }: ToolContext) =>
  app.scene.getNonDeletedElements();

/**
 * Looks the elements up by id, in the order given. Unknown, deleted and
 * (unless `includeLocked`) locked elements are reported together so that the
 * agent can fix the whole call at once.
 */
export const resolveElements = (
  { app }: ToolContext,
  ids: readonly string[],
  opts: { includeLocked?: boolean } = {},
): NonDeletedExcalidrawElement[] => {
  const map = app.scene.getNonDeletedElementsMap();
  const found: NonDeletedExcalidrawElement[] = [];
  const missing: string[] = [];
  const locked: string[] = [];
  for (const id of new Set(ids)) {
    const element = map.get(id);
    if (!element) {
      missing.push(id);
    } else if (element.locked && !opts.includeLocked) {
      locked.push(id);
    } else {
      found.push(element);
    }
  }
  if (missing.length) {
    throw new ToolError(
      "not-found",
      `No element with id ${missing
        .slice(0, 10)
        .map((id) => `"${id}"`)
        .join(", ")}${
        missing.length > 10 ? ` (and ${missing.length - 10} more)` : ""
      }. Use get-elements to list the ids on the canvas.`,
    );
  }
  if (locked.length) {
    throw new ToolError(
      "invalid-input",
      `Element(s) ${locked
        .slice(0, 10)
        .map((id) => `"${id}"`)
        .join(
          ", ",
        )} are locked. Unlock them first with update-elements ({ "locked": false }).`,
    );
  }
  return found;
};

/** ids of the elements that are nested within a frame that is also listed */
export const withoutFrameChildren = (
  elements: readonly NonDeletedExcalidrawElement[],
) => {
  const frameIds = new Set(
    elements.filter(isFrameLikeElement).map((frame) => frame.id),
  );
  return elements.filter(
    (element) => !element.frameId || !frameIds.has(element.frameId),
  );
};

/**
 * The top-left corner for a block of `width` x `height` that isn't placed
 * explicitly: centred in the viewport on an empty canvas, otherwise beside
 * the existing content (to its right, aligned with its top), where it can't
 * land on top of what's there.
 */
export const getFreePosition = (
  ctx: ToolContext,
  width: number,
  height: number,
): { x: number; y: number } => {
  const { app } = ctx;
  const elements = app.scene.getNonDeletedElements();
  if (!elements.length) {
    const { scrollX, scrollY, zoom, width: w, height: h } = app.state;
    return {
      x: -scrollX + w / zoom.value / 2 - width / 2,
      y: -scrollY + h / zoom.value / 2 - height / 2,
    };
  }
  const [, minY, maxX] = getCommonBounds(elements);
  if (!Number.isFinite(maxX) || !Number.isFinite(minY)) {
    // (the drawing holds elements with broken geometry)
    return { x: -app.state.scrollX, y: -app.state.scrollY };
  }
  return { x: maxX + PLACEMENT_GAP, y: minY };
};

/**
 * Applies the elements to the scene as one undoable step. Optionally leaves
 * `selectIds` selected, so that the user sees what the agent just touched.
 */
export const commitScene = (
  { app }: ToolContext,
  elements: readonly ExcalidrawElement[],
  opts: { selectIds?: readonly string[] } = {},
) => {
  app.syncActionResult({
    elements,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  if (opts.selectIds) {
    // after the scene has the elements
    if (opts.selectIds.length) {
      app.selection.select([...opts.selectIds]);
    } else {
      app.selection.clear();
    }
  }
};

/**
 * Brings the elements into view when they aren't (fully) visible, keeping
 * the current zoom if they fit.
 */
export const revealElements = (
  { app }: ToolContext,
  elements: readonly NonDeletedExcalidrawElement[],
) => {
  if (!elements.length) {
    return;
  }
  const { scrollX, scrollY, zoom, width, height } = app.state;
  const [x1, y1, x2, y2] = getCommonBounds(elements);
  const left = -scrollX;
  const top = -scrollY;
  const right = left + width / zoom.value;
  const bottom = top + height / zoom.value;
  if (x1 >= left && y1 >= top && x2 <= right && y2 <= bottom) {
    return;
  }
  app.viewport.setViewport({
    target: elements,
    fit: "scale-down",
    animation: true,
  });
};

/**
 * The arrow geometry to start from before binding. Binding snaps a straight
 * arrow's ends to the outlines of the elements along its line, so it can run
 * centre to centre. An elbow arrow keeps its ends where they are, so it
 * starts and ends at the middle of the facing edges, as the editor's
 * flowchart creation places its arrows.
 */
export const getConnectorGeometry = (
  arrow: ExcalidrawElement,
  from: ExcalidrawElement,
  to: ExcalidrawElement,
) => {
  const fromCenter = {
    x: from.x + from.width / 2,
    y: from.y + from.height / 2,
  };
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;

  let start = fromCenter;
  let end = toCenter;
  if (isElbowArrow(arrow)) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      start = { x: dx >= 0 ? from.x + from.width : from.x, y: fromCenter.y };
      end = { x: dx >= 0 ? to.x : to.x + to.width, y: toCenter.y };
    } else {
      start = { x: fromCenter.x, y: dy >= 0 ? from.y + from.height : from.y };
      end = { x: toCenter.x, y: dy >= 0 ? to.y : to.y + to.height };
    }
  }

  return {
    x: start.x,
    y: start.y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
    points: [
      pointFrom<any>(0, 0),
      pointFrom<any>(end.x - start.x, end.y - start.y),
    ],
  };
};

/**
 * Binds arrows to the elements at their two ends, as dragging an arrow's end
 * onto a shape does, so that they follow when the shapes move. The arrows
 * and elements have to be in the scene already.
 */
export const bindConnectors = (
  { app }: ToolContext,
  connectors: readonly {
    arrowId: string;
    fromId: string;
    toId: string;
  }[],
) => {
  const map = app.scene.getNonDeletedElementsMap();
  const touched = new Set<NonDeleted<ExcalidrawBindableElement>>();
  for (const { arrowId, fromId, toId } of connectors) {
    const arrow = map.get(arrowId) as NonDeleted<ExcalidrawArrowElement>;
    const from = map.get(fromId) as NonDeleted<ExcalidrawBindableElement>;
    const to = map.get(toId) as NonDeleted<ExcalidrawBindableElement>;
    if (!arrow || !from || !to) {
      continue;
    }
    bindBindingElement(
      arrow,
      from,
      "orbit",
      "start",
      app.scene,
      app.state.zoom,
    );
    bindBindingElement(arrow, to, "orbit", "end", app.scene, app.state.zoom);
    if (isElbowArrow(arrow)) {
      // elbow arrows are routed around their elements once bound
      app.scene.mutateElement(arrow, { points: arrow.points });
    }
    touched.add(from);
    touched.add(to);
  }
  // moves arrow labels along with their arrows' new ends
  touched.forEach((element) => updateBoundElements(element, app.scene));
};

import {
  isArrowElement,
  isFrameLikeElement,
  isLinearElement,
} from "@excalidraw/element";

import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
} from "@excalidraw/element/types";

import { isListedElement } from "../serialize";

import type { ToolDefinition } from "../common";

/** results listed per kind of problem, with the total beside them */
const MAX_LISTED = 20;
/** an arrow end this far from every shape is hanging in the air */
const LOOSE_END_DISTANCE = 12;
/** shapes checked pairwise for overlaps, to keep the check fast */
const MAX_SHAPES = 600;

type Listed<T> = { total: number; items: T[] };

const listed = <T>(all: T[]): Listed<T> => ({
  total: all.length,
  items: all.slice(0, MAX_LISTED),
});

/**
 * 1 on the outline of the shape, below 1 inside it, above 1 outside (the
 * outline of a rectangle, diamond or ellipse, not just its bounding box).
 */
const outlineRatio = (element: ExcalidrawElement, x: number, y: number) => {
  const dx =
    Math.abs(x - (element.x + element.width / 2)) / (element.width / 2);
  const dy =
    Math.abs(y - (element.y + element.height / 2)) / (element.height / 2);
  if (element.type === "diamond") {
    return dx + dy;
  }
  if (element.type === "ellipse") {
    return Math.hypot(dx, dy);
  }
  return Math.max(dx, dy);
};

/** distance from the point to the element's bounding box (0 inside or on it) */
const boxDistance = (element: ExcalidrawElement, x: number, y: number) =>
  Math.hypot(
    Math.max(element.x - x, 0, x - (element.x + element.width)),
    Math.max(element.y - y, 0, y - (element.y + element.height)),
  );

const contains = (outer: ExcalidrawElement, inner: ExcalidrawElement) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width &&
  outer.y + outer.height >= inner.y + inner.height;

const checkLayout: ToolDefinition = {
  name: "check-layout",
  title: "Check layout",
  description:
    "Lints the drawing without needing to see it: shapes that overlap, arrow ends that sit inside a shape instead of on its edge, arrow ends hanging in the air, and elements outside the visible area. Returns ids to fix. Run it after drawing.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  handler: (_input, { app }) => {
    const { state } = app;
    const elements = app.scene.getNonDeletedElements().filter(isListedElement);

    const shapes = elements.filter(
      (element) =>
        !isLinearElement(element) &&
        element.type !== "freedraw" &&
        !isFrameLikeElement(element),
    );

    // shapes that overlap without one sitting wholly inside the other
    const overlaps: { a: string; b: string; overlap: string }[] = [];
    const checked = shapes.slice(0, MAX_SHAPES);
    for (let i = 0; i < checked.length; i++) {
      for (let j = i + 1; j < checked.length; j++) {
        const a = checked[i];
        const b = checked[j];
        const width =
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const height =
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (width > 1 && height > 1 && !contains(a, b) && !contains(b, a)) {
          overlaps.push({
            a: a.id,
            b: b.id,
            overlap: `${Math.round(width)}x${Math.round(height)}`,
          });
        }
      }
    }

    const map = app.scene.getNonDeletedElementsMap();
    const insideTarget: { arrow: string; end: string; shape: string }[] = [];
    const insideShape: { arrow: string; end: string; shape: string }[] = [];
    const loose: { arrow: string; end: string }[] = [];

    for (const arrow of elements.filter((element) =>
      isArrowElement(element),
    ) as ExcalidrawArrowElement[]) {
      const ends = [
        ["start", arrow.points[0], arrow.startBinding?.elementId],
        [
          "end",
          arrow.points[arrow.points.length - 1],
          arrow.endBinding?.elementId,
        ],
      ] as const;
      for (const [end, point, boundId] of ends) {
        const x = arrow.x + point[0];
        const y = arrow.y + point[1];
        const target = boundId ? map.get(boundId) : undefined;
        if (target) {
          // attached, yet ending well inside its target (snapped to the middle)
          if (outlineRatio(target, x, y) < 0.9) {
            insideTarget.push({ arrow: arrow.id, end, shape: target.id });
          }
          continue;
        }
        const inside = shapes.find((shape) => outlineRatio(shape, x, y) < 0.9);
        if (inside) {
          insideShape.push({ arrow: arrow.id, end, shape: inside.id });
        } else if (
          shapes.every((shape) => boxDistance(shape, x, y) > LOOSE_END_DISTANCE)
        ) {
          loose.push({ arrow: arrow.id, end });
        }
      }
    }

    // elements wholly outside the area the user currently sees
    const zoom = state.zoom.value;
    const view = {
      left: -state.scrollX,
      top: -state.scrollY,
      right: -state.scrollX + state.width / zoom,
      bottom: -state.scrollY + state.height / zoom,
    };
    const offscreen = elements
      .filter(
        (element) =>
          element.x > view.right ||
          element.y > view.bottom ||
          element.x + element.width < view.left ||
          element.y + element.height < view.top,
      )
      .map((element) => element.id);

    const problems =
      overlaps.length + insideTarget.length + insideShape.length + loose.length;
    return {
      problems,
      overlaps: listed(overlaps),
      arrowEndsInsideTarget: listed(insideTarget),
      arrowEndsInsideShape: listed(insideShape),
      looseArrowEnds: listed(loose),
      offscreen: {
        total: offscreen.length,
        ids: offscreen.slice(0, MAX_LISTED),
        note: offscreen.length
          ? "Use focus-viewport to bring the drawing into view."
          : undefined,
      },
    };
  },
};

export const inspectTools = [checkLayout];

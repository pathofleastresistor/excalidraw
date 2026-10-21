import { FONT_FAMILY } from "@excalidraw/common";

import {
  getBoundTextElement,
  isArrowElement,
  isFrameLikeElement,
  isLinearElement,
  isTextElement,
} from "@excalidraw/element";

import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

/** longest text returned for a single element, to keep tool output small */
const MAX_TEXT_LENGTH = 400;

const round = (value: number) => Math.round(value * 10) / 10;

const truncate = (text: string) =>
  text.length > MAX_TEXT_LENGTH
    ? `${text.slice(0, MAX_TEXT_LENGTH)}… (${
        text.length - MAX_TEXT_LENGTH
      } more characters)`
    : text;

const FONT_NAMES = Object.fromEntries(
  Object.entries(FONT_FAMILY).map(([name, id]) => [id, name]),
) as Record<number, string>;

export const getFontFamilyName = (fontFamily: number) =>
  FONT_NAMES[fontFamily] ?? String(fontFamily);

export type ElementDetail = "summary" | "full";

/**
 * Compact, agent-facing description of an element. Angles are in degrees,
 * and a container's label is inlined as `text` (its bound text element isn't
 * listed on its own).
 */
export const serializeElement = (
  element: NonDeletedExcalidrawElement,
  elementsMap: ElementsMap,
  detail: ElementDetail,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: element.id,
    type: element.type,
    x: round(element.x),
    y: round(element.y),
    width: round(element.width),
    height: round(element.height),
  };

  if (isTextElement(element)) {
    out.text = truncate(element.text);
    if (element.containerId) {
      out.containerId = element.containerId;
    }
  } else {
    const label = getBoundTextElement(element, elementsMap);
    if (label) {
      out.text = truncate(label.text);
    }
  }
  if (isFrameLikeElement(element) && element.name) {
    out.name = truncate(element.name);
  }
  if (element.frameId) {
    out.frameId = element.frameId;
  }
  if (element.groupIds.length) {
    out.groupIds = element.groupIds;
  }
  if (isArrowElement(element)) {
    if (element.startBinding) {
      out.from = element.startBinding.elementId;
    }
    if (element.endBinding) {
      out.to = element.endBinding.elementId;
    }
  }
  if (element.locked) {
    out.locked = true;
  }

  if (detail === "summary") {
    return out;
  }

  out.angle = round((element.angle * 180) / Math.PI);
  out.strokeColor = element.strokeColor;
  out.backgroundColor = element.backgroundColor;
  out.fillStyle = element.fillStyle;
  out.strokeWidth = element.strokeWidth;
  out.strokeStyle = element.strokeStyle;
  out.roughness = element.roughness;
  out.opacity = element.opacity;
  out.roundness = element.roundness ? "round" : "sharp";
  if (isTextElement(element)) {
    out.fontSize = element.fontSize;
    out.fontFamily = getFontFamilyName(element.fontFamily);
    out.textAlign = element.textAlign;
    out.verticalAlign = element.verticalAlign;
  }
  if (isLinearElement(element)) {
    out.points = element.points.map(([x, y]) => [round(x), round(y)]);
    if (isArrowElement(element)) {
      out.startArrowhead = element.startArrowhead;
      out.endArrowhead = element.endArrowhead;
    }
  }
  if (element.link) {
    out.link = truncate(element.link);
  }
  return out;
};

/** whether the element is listed in its own right (labels are inlined) */
export const isListedElement = (element: ExcalidrawElement) =>
  !(isTextElement(element) && element.containerId);

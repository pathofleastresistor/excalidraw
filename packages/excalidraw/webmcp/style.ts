import { FONT_FAMILY, TEXT_ALIGN } from "@excalidraw/common";

import { getDefaultRoundnessTypeForElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  FillStyle,
  FontFamilyValues,
  StrokeStyle,
} from "@excalidraw/element/types";

import { ToolError } from "./common";
import { readColor, readEnum, readNumber } from "./input";

import type { WebMCPJSONSchema } from "./types";
import type { AppState } from "../types";

type Input = Record<string, unknown>;

const FILL_STYLES = ["hachure", "cross-hatch", "solid", "zigzag"] as const;
const STROKE_STYLES = ["solid", "dashed", "dotted"] as const;
const ROUNDNESS_MODES = ["round", "sharp"] as const;
const FONT_NAMES = Object.keys(FONT_FAMILY) as [
  keyof typeof FONT_FAMILY,
  ...(keyof typeof FONT_FAMILY)[],
];
const TEXT_ALIGNS = Object.values(TEXT_ALIGN) as string[];
const VERTICAL_ALIGNS = ["top", "middle", "bottom"] as const;

/** the visual properties shared by creating and updating elements */
export const STYLE_SCHEMA: Record<string, WebMCPJSONSchema> = {
  strokeColor: {
    type: "string",
    description: 'outline/text color, e.g. "#1e1e1e" or "red"',
  },
  backgroundColor: {
    type: "string",
    description: 'fill color, e.g. "#a5d8ff", or "transparent"',
  },
  fillStyle: { type: "string", enum: FILL_STYLES },
  strokeWidth: { type: "number", description: "1 thin, 2 bold, 4 extra bold" },
  strokeStyle: { type: "string", enum: STROKE_STYLES },
  roughness: {
    type: "number",
    description: "0 architect, 1 artist, 2 cartoonist",
  },
  opacity: { type: "number", description: "0 (transparent) to 100" },
  roundness: {
    type: "string",
    enum: ROUNDNESS_MODES,
    description: "round or sharp corners",
  },
};

export const TEXT_STYLE_SCHEMA: Record<string, WebMCPJSONSchema> = {
  fontSize: { type: "number", description: "in pixels, e.g. 16, 20, 28, 36" },
  fontFamily: { type: "string", enum: FONT_NAMES },
  textAlign: { type: "string", enum: TEXT_ALIGNS },
  verticalAlign: { type: "string", enum: VERTICAL_ALIGNS },
};

export type ElementStyle = {
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: FillStyle;
  strokeWidth?: number;
  strokeStyle?: StrokeStyle;
  roughness?: number;
  opacity?: number;
  roundness?: "round" | "sharp";
};

export type TextStyle = {
  fontSize?: number;
  fontFamily?: FontFamilyValues;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
};

const readFontFamily = (input: Input, path: string) => {
  const name = readEnum(input, "fontFamily", FONT_NAMES, { path });
  return name === undefined ? undefined : FONT_FAMILY[name];
};

export const readStyle = (input: Input, pathPrefix = ""): ElementStyle => {
  const path = (key: string) => `${pathPrefix}${key}`;
  const style: ElementStyle = {
    strokeColor: readColor(input, "strokeColor", path("strokeColor")),
    backgroundColor: readColor(
      input,
      "backgroundColor",
      path("backgroundColor"),
    ),
    fillStyle: readEnum(input, "fillStyle", FILL_STYLES, {
      path: path("fillStyle"),
    }),
    strokeWidth: readNumber(input, "strokeWidth", {
      min: 0.5,
      max: 20,
      path: path("strokeWidth"),
    }),
    strokeStyle: readEnum(input, "strokeStyle", STROKE_STYLES, {
      path: path("strokeStyle"),
    }),
    roughness: readNumber(input, "roughness", {
      min: 0,
      max: 2,
      path: path("roughness"),
    }),
    opacity: readNumber(input, "opacity", {
      min: 0,
      max: 100,
      path: path("opacity"),
    }),
    roundness: readEnum(input, "roundness", ROUNDNESS_MODES, {
      path: path("roundness"),
    }),
  };
  return dropUndefined(style);
};

export const readTextStyle = (input: Input, pathPrefix = ""): TextStyle => {
  const path = (key: string) => `${pathPrefix}${key}`;
  const textAlign = readEnum(input, "textAlign", TEXT_ALIGNS, {
    path: path("textAlign"),
  }) as TextStyle["textAlign"];
  return dropUndefined({
    fontSize: readNumber(input, "fontSize", {
      min: 4,
      max: 400,
      path: path("fontSize"),
    }),
    fontFamily: readFontFamily(input, path("fontFamily")),
    textAlign,
    verticalAlign: readEnum(input, "verticalAlign", VERTICAL_ALIGNS, {
      path: path("verticalAlign"),
    }),
  });
};

export const dropUndefined = <T extends Record<string, unknown>>(
  object: T,
): T => {
  for (const key of Object.keys(object)) {
    if (object[key] === undefined) {
      delete object[key];
    }
  }
  return object;
};

/** the element-constructor props for a style, without fallbacks */
export const toElementProps = (
  type: ExcalidrawElement["type"],
  style: ElementStyle,
) => {
  const { roundness, ...rest } = style;
  return {
    ...rest,
    ...(roundness
      ? {
          roundness:
            roundness === "round"
              ? getDefaultRoundnessTypeForElement({ type } as ExcalidrawElement)
              : null,
        }
      : {}),
  };
};

/**
 * What the user would get drawing the next element by hand: the editor's
 * current style settings, so that what the agent adds matches the drawing.
 */
export const getUserStyleDefaults = (state: AppState): ElementStyle => ({
  strokeColor: state.currentItemStrokeColor,
  backgroundColor: state.currentItemBackgroundColor,
  fillStyle: state.currentItemFillStyle,
  strokeStyle: state.currentItemStrokeStyle,
  roughness: state.currentItemRoughness,
  opacity: state.currentItemOpacity,
  roundness: state.currentItemRoundness,
});

export const assertNonEmpty = (
  patch: Record<string, unknown>,
  what: string,
) => {
  if (!Object.keys(patch).length) {
    throw new ToolError("invalid-input", `Nothing to change: ${what}`);
  }
};

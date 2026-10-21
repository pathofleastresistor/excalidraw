import { ToolError } from "./common";

/**
 * Input readers. WebMCP guidance is to validate strictly in code and loosely
 * in the schema, so that a bad call gets an error telling the agent what to
 * fix. Each reader throws a `ToolError` naming the parameter.
 */

type Input = Record<string, unknown>;

const invalid = (path: string, expectation: string): never => {
  throw new ToolError("invalid-input", `"${path}" must be ${expectation}.`);
};

export const isRecord = (value: unknown): value is Input =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readRecord = (value: unknown, path: string): Input =>
  isRecord(value) ? value : invalid(path, "an object");

export function readString(
  input: Input,
  key: string,
  opts: { required: true; maxLength?: number; path?: string },
): string;
export function readString(
  input: Input,
  key: string,
  opts?: { required?: false; maxLength?: number; path?: string },
): string | undefined;
export function readString(
  input: Input,
  key: string,
  opts: { required?: boolean; maxLength?: number; path?: string } = {},
) {
  const path = opts.path ?? key;
  const value = input[key];
  if (value == null) {
    return opts.required ? invalid(path, "a string") : undefined;
  }
  if (typeof value !== "string") {
    return invalid(path, "a string");
  }
  if (opts.maxLength != null && value.length > opts.maxLength) {
    return invalid(path, `at most ${opts.maxLength} characters`);
  }
  return value;
}

export function readNumber(
  input: Input,
  key: string,
  opts: {
    required: true;
    min?: number;
    max?: number;
    integer?: boolean;
    path?: string;
  },
): number;
export function readNumber(
  input: Input,
  key: string,
  opts?: {
    required?: false;
    min?: number;
    max?: number;
    integer?: boolean;
    path?: string;
  },
): number | undefined;
export function readNumber(
  input: Input,
  key: string,
  opts: {
    required?: boolean;
    min?: number;
    max?: number;
    integer?: boolean;
    path?: string;
  } = {},
) {
  const path = opts.path ?? key;
  const value = input[key];
  if (value == null) {
    return opts.required ? invalid(path, "a number") : undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid(path, "a finite number");
  }
  if (opts.integer && !Number.isInteger(value)) {
    return invalid(path, "an integer");
  }
  if (opts.min != null && value < opts.min) {
    return invalid(path, `at least ${opts.min}`);
  }
  if (opts.max != null && value > opts.max) {
    return invalid(path, `at most ${opts.max}`);
  }
  return value;
}

export const readBoolean = (
  input: Input,
  key: string,
  path = key,
): boolean | undefined => {
  const value = input[key];
  if (value == null) {
    return undefined;
  }
  return typeof value === "boolean" ? value : invalid(path, "true or false");
};

export function readEnum<T extends string>(
  input: Input,
  key: string,
  allowed: readonly T[],
  opts: { required: true; path?: string },
): T;
export function readEnum<T extends string>(
  input: Input,
  key: string,
  allowed: readonly T[],
  opts?: { required?: false; path?: string },
): T | undefined;
export function readEnum<T extends string>(
  input: Input,
  key: string,
  allowed: readonly T[],
  opts: { required?: boolean; path?: string } = {},
) {
  const path = opts.path ?? key;
  const value = input[key];
  if (value == null) {
    return opts.required
      ? invalid(path, `one of ${allowed.join(", ")}`)
      : undefined;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return invalid(path, `one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function readArray(
  input: Input,
  key: string,
  opts: { required: true; minItems?: number; maxItems: number; path?: string },
): unknown[];
export function readArray(
  input: Input,
  key: string,
  opts: {
    required?: false;
    minItems?: number;
    maxItems: number;
    path?: string;
  },
): unknown[] | undefined;
export function readArray(
  input: Input,
  key: string,
  opts: {
    required?: boolean;
    minItems?: number;
    maxItems: number;
    path?: string;
  },
) {
  const path = opts.path ?? key;
  const value = input[key];
  if (value == null) {
    return opts.required ? invalid(path, "an array") : undefined;
  }
  if (!Array.isArray(value)) {
    return invalid(path, "an array");
  }
  if (value.length < (opts.minItems ?? 0)) {
    return invalid(path, `an array of at least ${opts.minItems} item(s)`);
  }
  if (value.length > opts.maxItems) {
    return invalid(
      path,
      `an array of at most ${opts.maxItems} items; split the work over several calls`,
    );
  }
  return value;
}

/** the ids of elements, as an array of strings */
export const readIds = (
  input: Input,
  key: string,
  opts: { required?: boolean; maxItems?: number } = {},
): string[] | undefined => {
  const value = readArray(input, key, {
    required: opts.required as true,
    minItems: opts.required ? 1 : 0,
    maxItems: opts.maxItems ?? 500,
  });
  if (!value) {
    return undefined;
  }
  return value.map((id, index) =>
    typeof id === "string" && id
      ? id
      : invalid(`${key}[${index}]`, "an element id string"),
  );
};

const NAMED_OR_FUNCTIONAL_COLOR = /^(?:[a-z]+|(?:rgb|hsl)a?\([\d\s.,%/-]+\))$/i;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** a CSS color: hex, rgb()/hsl(), a color name, or "transparent" */
export const readColor = (
  input: Input,
  key: string,
  path = key,
): string | undefined => {
  const value = readString(input, key, { maxLength: 64, path });
  if (value === undefined) {
    return undefined;
  }
  const color = value.trim();
  if (!HEX_COLOR.test(color) && !NAMED_OR_FUNCTIONAL_COLOR.test(color)) {
    return invalid(
      path,
      'a CSS color such as "#1e1e1e", "rgb(30, 30, 30)", "red" or "transparent"',
    );
  }
  if (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    !CSS.supports("color", color)
  ) {
    return invalid(path, "a color the browser understands");
  }
  return color;
};

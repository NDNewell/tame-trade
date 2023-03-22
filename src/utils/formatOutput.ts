// src/utils/formatOutput.ts

export type Color =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray";

export type FontStyle = "bold" | "italic" | "underline";

const colorMap: Record<Color, string> = {
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

const fontStyleMap: Record<FontStyle, string> = {
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
};

export function formatOutput(
  text: string,
  color: Color = "white",
  fontStyle?: FontStyle
): string {
  const colorCode = colorMap[color];
  const fontStyleCode = fontStyle ? fontStyleMap[fontStyle] : "";
  const resetCode = "\x1b[0m";

  return `${fontStyleCode}${colorCode}${text}${resetCode}`;
}

// src/utils/formatOutput.ts

export type Color =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'purple'
  | 'pink'
  | 'orange'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite';

export type FontStyle = 'bold' | 'italic' | 'underline';

const colorMap: Record<Color, string> = {
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  purple: '\x1b[95m',
  pink: '\x1b[91m',
  orange: '\x1b[38;5;214m',
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
};

const fontStyleMap: Record<FontStyle, string> = {
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
};

export function formatOutput(
  text: string,
  color: Color = 'white',
  fontStyle?: FontStyle
): string {
  const colorCode = colorMap[color];
  const fontStyleCode = fontStyle ? fontStyleMap[fontStyle] : '';
  const resetCode = '\x1b[0m';

  return `${fontStyleCode}${colorCode}${text}${resetCode}`;
}

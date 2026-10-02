/**
 * Text from HEY's API is partly external (project names, release titles):
 * data, never instructions. JSON escapes control characters, but bidirectional
 * overrides and zero-width characters survive escaping and can make a line
 * read differently from what it holds, so they are removed. Newlines and tabs
 * stay; nothing else about the text is changed.
 */
const UNSAFE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export function cleanText(value: string): string {
  return value.replace(UNSAFE, '');
}

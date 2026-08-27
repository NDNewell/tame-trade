// src/ui/wrap.ts
//
// Greedy word wrap, in one place.
//
// Extracted because two things now need to agree about it exactly: the frame,
// which paints the rows, and the block layer, which decides where a paragraph
// has grown long enough to split. A second implementation that wrapped even
// slightly differently would have the splitter counting rows the renderer never
// produced.

/**
 * A token longer than the column is broken rather than clipped: it is nearly
 * always a number, and half a number read as a whole one is the kind of mistake
 * this application exists to avoid.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];

  const out: string[] = [];

  for (const paragraph of String(text).split('\n')) {
    const words: string[] = [];
    for (const word of paragraph.split(/\s+/)) {
      if (word.length === 0) continue;
      for (let i = 0; i < word.length; i += width) words.push(word.slice(i, i + width));
    }

    let line = '';
    for (const word of words) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ' ' + word;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line.length > 0) out.push(line);
  }

  return out;
}

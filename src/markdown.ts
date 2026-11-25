export function escapeMarkdownInline(value: string): string {
  return value.replace(/([`*_{}[\]()#+.!|>~-])/g, '\\$1');
}

export function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

/** Escape table delimiters and wrap a cell with explicit Markdown line breaks. */
export function wrapMarkdownTableCell(value: string, maxWidth: number = 80): string {
  if (!Number.isInteger(maxWidth) || maxWidth < 1) {
    throw new Error('Markdown table cell width must be a positive integer.');
  }
  const safe = value.replace(/\r\n?|\n/g, ' ');
  const words = safe.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    let remaining = word;
    while (remaining.length > maxWidth) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(remaining.slice(0, maxWidth));
      remaining = remaining.slice(maxWidth);
    }
    if (!remaining) continue;
    if (line && line.length + 1 + remaining.length > maxWidth) {
      lines.push(line);
      line = remaining;
    } else {
      line = line ? `${line} ${remaining}` : remaining;
    }
  }
  if (line) lines.push(line);
  return lines.map((wrappedLine) => wrappedLine.replace(/\|/g, '&#124;')).join('<br>');
}

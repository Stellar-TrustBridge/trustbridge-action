export function escapeMarkdownInline(value: string): string {
  return value.replace(/([`*_{}[\]()#+.!|>~-])/g, '\\$1');
}

export function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

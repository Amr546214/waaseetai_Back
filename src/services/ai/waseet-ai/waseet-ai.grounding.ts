/** Provider display markup is transported as bounded text; rendering belongs to the UI sanitizer. */
export function readSearchSuggestionsHtml(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64_000 ? value : undefined;
}

/** Compact text for a one-line display: collapse whitespace, cap length. */
export function summarize(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

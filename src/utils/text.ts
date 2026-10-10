/**
 * Pure text/markdown helpers shared by the card layer and command handlers.
 * No dependencies outside this module.
 */

/**
 * Escape untrusted text before embedding into Feishu lark_md. `[ ] ( ) !`
 * are included so untrusted content cannot forge a link or image
 * (`[x](url)` / `![](url)`) inside card markdown.
 */
export function escapeMd(s: string): string {
  return s.replace(/([*_`\\[\]()!])/g, '\\$1');
}

/**
 * Neutralise content that goes INSIDE an inline code span. Backslash escapes
 * are not processed inside a code span, so `escapeMd` there renders visible
 * backslashes (`src/a\(b\).ts`); the span itself already suppresses markdown,
 * only the delimiter needs handling.
 */
export function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}

/** Compact text for a one-line display: collapse whitespace, cap length.
 *  Plain-text only — does NOT escape markdown. Use `summarizeMd` when the
 *  result is rendered into a markdown element (user message content can
 *  otherwise inject/break markdown: stray `` ` `` `, `*`, `_`). */
export function summarize(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Markdown-safe variant of `summarize`: collapse + cap + escape. Order
 *  matters — truncate on the raw text first, then escape the clipped result,
 *  so a truncation point can never split an escape sequence (`\*`). */
export function summarizeMd(text: string, max = 48): string {
  return escapeMd(summarize(text, max));
}

/** Sanitize a value destined for a markdown code span (`` `value` ``): a
 *  backtick inside the value would close the span early and scramble the
 *  rest of the message. Replace backticks with apostrophes. */
export function codeSpan(s: string): string {
  return s.replace(/`/g, "'");
}

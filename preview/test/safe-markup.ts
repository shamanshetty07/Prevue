import { strict as assert } from "node:assert";

/** Every element and attribute that can appear in rendered output. Anything else (script, img, a, on*, href, src, style, ...) fails. */
export const ELEMENTS = new Set(["div", "header", "h1", "h2", "h3", "p", "nav", "ul", "li", "span", "main", "button", "svg", "path", "table", "caption", "thead", "tbody", "tr", "th", "td"]);
export const ATTRS = /^(class|type|title|scope|colspan|role|tabindex|focusable|d|viewBox|width|height|fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|data-[a-z-]+|aria-[a-z-]+)$/;
export function assertOnlySafeMarkup(out: string, label = "", elements: ReadonlySet<string> = ELEMENTS, allowedAttrs: RegExp = ATTRS): void {
  // Real tags only: React escapes < in text and quotes in attribute values, so a "<" in the output always starts a tag.
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9:-]*(?:="[^"<>]*")?)*)\s*(\/?)>/g;
  const stripped = out.replace(tag, (_m, close: string, name: string, attrs: string) => {
    assert.ok(elements.has(name.toLowerCase()), `${label}: element <${name}> is not allowed`);
    if (!close) for (const a of attrs.matchAll(/\s+([a-zA-Z][a-zA-Z0-9:-]*)(?:="[^"<>]*")?/g)) assert.ok(allowedAttrs.test(a[1]!), `${label}: attribute ${a[1]} is not allowed on <${name}>`);
    return "";
  });
  assert.ok(!stripped.includes("<"), `${label}: a "<" is left over, so something is not a well-formed allowed tag: ${stripped.slice(stripped.indexOf("<"), stripped.indexOf("<") + 80)}`);
}

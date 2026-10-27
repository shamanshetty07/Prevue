import type { SpecIssue } from "./validate.js";

/**
 * JSON.parse silently keeps the last of two equal keys, so a reviewer reading the raw text could see a value that the
 * hash and the preview never use. This scans the text once, iteratively (no recursion, no stack growth on hostile
 * nesting), and reports every object that repeats a key. Keys are compared after decoding, so "a" and "a" collide.
 *
 * It is a scanner, not a parser: it assumes the caller has already run JSON.parse on the same text, and it reports
 * "malformed" instead of guessing if the structure does not balance. It never throws and never echoes a value.
 */
const MAX_ISSUES = 50;
const clip = (s: string, n = 40): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const seg = (s: string | number): string => `/${String(clip(String(s))).replace(/~/g, "~0").replace(/\//g, "~1")}`;

interface Frame {
  obj: boolean;
  keys: Set<string>;
  expectKey: boolean;
  /** Current child: the last key of an object, or the index within an array. */
  at: string | number;
}

export function scanDuplicateKeys(text: string): SpecIssue[] | "malformed" {
  const issues: SpecIssue[] = [];
  const stack: Frame[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= n) return "malformed";
      const top = stack[stack.length - 1];
      if (top?.obj && top.expectKey) {
        const raw = text.slice(i + 1, j);
        let key: string;
        try {
          key = raw.includes("\\") ? (JSON.parse(`"${raw}"`) as string) : raw;
        } catch {
          return "malformed";
        }
        top.expectKey = false;
        top.at = key;
        if (top.keys.has(key)) {
          if (issues.length < MAX_ISSUES) issues.push({ path: stack.map((f) => seg(f.at)).join(""), code: "duplicate_key", message: "an object repeats a property name; each name may appear once" });
        } else top.keys.add(key);
      }
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") {
      stack.push({ obj: c === "{", keys: new Set(), expectKey: c === "{", at: c === "{" ? "" : 0 });
    } else if (c === "}" || c === "]") {
      const top = stack.pop();
      if (!top || top.obj !== (c === "}")) return "malformed";
    } else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.obj) top.expectKey = true;
      else if (top) top.at = (top.at as number) + 1;
    }
    i++;
  }
  return stack.length === 0 ? issues : "malformed";
}

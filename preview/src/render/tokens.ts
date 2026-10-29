import type { Space } from "../../../server/src/spec/schema.js";

/**
 * Every visual choice in a specification is a named token; this file is the only place tokens become presentation, and it
 * produces class names from fixed lookup tables. Nothing from a specification is ever placed in a style attribute, a URL
 * or a class name directly, so a value that is not in a table has no way to reach the DOM.
 */
const SPACE: Record<Space, string> = { none: "s-none", xs: "s-xs", sm: "s-sm", md: "s-md", lg: "s-lg", xl: "s-xl" };
export const gapClass = (s: Space): string => `gap-${SPACE[s]}`;
export const padClass = (s: Space): string => `pad-${SPACE[s]}`;

const COLS = ["", "cols-1", "cols-2", "cols-3", "cols-4"] as const;
export const colsClass = (n: number): string => COLS[n] ?? COLS[1];

const pick = <T extends string>(table: Record<T, string>, key: T): string => (Object.hasOwn(table, key) ? table[key] : "");
export const variantClass = (prefix: string, key: string): string => `${prefix}-${pick({ heading: "heading", subheading: "subheading", body: "body", caption: "caption", primary: "primary", secondary: "secondary", ghost: "ghost", danger: "danger" } as Record<string, string>, key)}`;
export const toneClass = (key: string): string => `tone-${pick({ default: "default", muted: "muted", accent: "accent", success: "success", danger: "danger" } as Record<string, string>, key)}`;
export const alignClass = (key: string): string => `align-${pick({ start: "start", center: "center", end: "end", stretch: "stretch" } as Record<string, string>, key)}`;
export const trendClass = (key: string): string => `trend-${pick({ up: "up", down: "down", flat: "flat" } as Record<string, string>, key)}`;
export const TREND_MARK: Record<string, string> = { up: "▲", down: "▼", flat: "▬" };

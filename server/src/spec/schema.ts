import { z } from "zod";

/**
 * UI specification, schema version 1.
 *
 * Plain data only: every object is strict (an unknown key is an error, because an ignored key that still changed the
 * hash would be a silent approval mismatch), and every visual choice is a named token. There is no HTML, CSS, URL,
 * file path, script or event handler anywhere in the format. Validation is not approval: nothing here touches the gate.
 */
export const SPEC_SCHEMA_VERSION = 1;

export const LIMITS = {
  rawBytes: 64 * 1024,
  rawJsonDepth: 24,
  rawJsonValues: 2000,
  nodes: 60,
  nesting: 4,
  children: 12,
  headerActions: 3,
  sidebarItems: 10,
  tableColumns: 8,
  tableRows: 12,
} as const;

// Control characters, and the bidi overrides/isolates that can make reviewed text read differently from its content.
const FORBIDDEN_CHARS = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;
// A surrogate that is not half of a valid pair (String.prototype.isWellFormed needs a newer lib target than tsconfig sets).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Plain text: NFC-normalized, trimmed, no control or bidi-override characters. Escaping is the renderer's job. */
const text = (max: number, min = 1) =>
  z
    .string()
    .transform((s) => s.normalize("NFC").trim())
    .pipe(
      z
        .string()
        .min(min)
        .max(max)
        .refine((s) => !LONE_SURROGATE.test(s) && !FORBIDDEN_CHARS.test(s), "contains control, bidi-override or malformed characters"),
    );

const id = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "id must be lowercase letters, digits and hyphens, starting with a letter");
const space = z.enum(["none", "xs", "sm", "md", "lg", "xl"]);
const tone = z.enum(["default", "muted", "accent", "success", "danger"]);
const accent = z.enum(["blue", "green", "purple", "orange", "red", "gray"]);
const icon = z.enum(["home", "chart", "list", "wallet", "users", "settings", "bell", "file"]);

export const Button = z.strictObject({
  type: z.literal("button"),
  id: id.optional(),
  label: text(40),
  variant: z.enum(["primary", "secondary", "ghost", "danger"]).default("secondary"),
  /** Describes what the button would do; the preview never runs it. */
  note: text(80).optional(),
});

export const Text = z.strictObject({
  type: z.literal("text"),
  id: id.optional(),
  content: text(500),
  variant: z.enum(["heading", "subheading", "body", "caption"]).default("body"),
  tone: tone.default("default"),
});

export const StatCard = z.strictObject({
  type: z.literal("stat-card"),
  id: id.optional(),
  label: text(40),
  value: text(40),
  delta: z.strictObject({ text: text(20), trend: z.enum(["up", "down", "flat"]) }).optional(),
  hint: text(80).optional(),
});

export const Table = z
  .strictObject({
    type: z.literal("table"),
    id: id.optional(),
    caption: text(80).optional(),
    emptyText: text(80).optional(),
    columns: z
      .array(z.strictObject({ key: id, header: text(30), align: z.enum(["start", "center", "end"]).default("start") }))
      .min(1)
      .max(LIMITS.tableColumns),
    rows: z.array(z.array(text(60, 0)).max(LIMITS.tableColumns)).max(LIMITS.tableRows),
  })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    t.columns.forEach((c, i) => {
      if (seen.has(c.key)) ctx.addIssue({ code: "custom", path: ["columns", i, "key"], message: "duplicate column key" });
      seen.add(c.key);
    });
    t.rows.forEach((r, i) => {
      if (r.length !== t.columns.length) ctx.addIssue({ code: "custom", path: ["rows", i], message: `row has ${r.length} cells but there are ${t.columns.length} columns` });
    });
  });

export const Stack = z.strictObject({
  type: z.literal("stack"),
  id: id.optional(),
  direction: z.enum(["row", "column"]).default("column"),
  gap: space.default("md"),
  align: z.enum(["start", "center", "end", "stretch"]).default("stretch"),
  get children() {
    return z.array(Node).max(LIMITS.children);
  },
});

export const Grid = z.strictObject({
  type: z.literal("grid"),
  id: id.optional(),
  columns: z.number().int().min(1).max(4),
  gap: space.default("md"),
  get children() {
    return z.array(Node).max(LIMITS.children);
  },
});

/** Components that may appear in the main region. Header and sidebar are fixed slots and cannot be nested. */
export const Node: z.ZodType<NodeSpec> = z.discriminatedUnion("type", [Stack, Grid, Text, Button, StatCard, Table]) as z.ZodType<NodeSpec>;

export const Header = z.strictObject({
  type: z.literal("header"),
  id: id.optional(),
  title: text(60),
  subtitle: text(80).optional(),
  actions: z.array(Button).max(LIMITS.headerActions).default([]),
});

export const Sidebar = z.strictObject({
  type: z.literal("sidebar"),
  id: id.optional(),
  title: text(40).optional(),
  width: z.enum(["narrow", "normal"]).default("normal"),
  items: z
    .array(z.strictObject({ label: text(30), icon: icon.optional(), active: z.boolean().default(false) }))
    .min(1)
    .max(LIMITS.sidebarItems),
});

export const uiSpecSchema = z.strictObject({
  schemaVersion: z.literal(SPEC_SCHEMA_VERSION),
  screen: z.strictObject({ kind: z.literal("dashboard"), name: text(80), purpose: text(300) }),
  theme: z.strictObject({ mode: z.enum(["light", "dark"]), accent: accent.default("blue") }),
  layout: z.strictObject({
    header: Header.optional(),
    sidebar: Sidebar.optional(),
    main: z.strictObject({
      gap: space.default("md"),
      padding: space.default("md"),
      children: z.array(Node).max(LIMITS.children),
    }),
  }),
});

// ---- types (written out because the schema is recursive) -----------------------------------------------------

export type Space = z.infer<typeof space>;
export type ButtonSpec = z.infer<typeof Button>;
export type TextSpec = z.infer<typeof Text>;
export type StatCardSpec = z.infer<typeof StatCard>;
export type TableSpec = z.infer<typeof Table>;
export interface StackSpec {
  type: "stack";
  id?: string | undefined;
  direction: "row" | "column";
  gap: Space;
  align: "start" | "center" | "end" | "stretch";
  children: NodeSpec[];
}
export interface GridSpec {
  type: "grid";
  id?: string | undefined;
  columns: number;
  gap: Space;
  children: NodeSpec[];
}
export type NodeSpec = StackSpec | GridSpec | TextSpec | ButtonSpec | StatCardSpec | TableSpec;
export type HeaderSpec = z.infer<typeof Header>;
export type SidebarSpec = z.infer<typeof Sidebar>;
export interface UiSpec {
  schemaVersion: 1;
  screen: { kind: "dashboard"; name: string; purpose: string };
  theme: { mode: "light" | "dark"; accent: z.infer<typeof accent> };
  layout: { header?: HeaderSpec | undefined; sidebar?: SidebarSpec | undefined; main: { gap: Space; padding: Space; children: NodeSpec[] } };
}

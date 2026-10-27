import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scanDuplicateKeys } from "../src/spec/dupkeys.js";
import { LIMITS } from "../src/spec/schema.js";
import { parseSpecText, specHash, validateSpec } from "../src/spec/validate.js";
import { validateFile } from "../src/validate-cli.js";
import { tmp } from "./helpers.js";

const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const EXAMPLE_HASH = "35697edb15a494a516be9faf1075a9b41ddc7c6ea0ba0e8d92808e37a94c4cd5";

const paths = (t: string): string[] => {
  const r = scanDuplicateKeys(t);
  assert.notEqual(r, "malformed", t);
  return (r as Array<{ path: string }>).map((i) => i.path);
};

test("dupkeys: the motivating example is rejected", () => {
  assert.deepEqual(paths('{\n  "background": "#ffffff",\n  "background": "#000000"\n}'), ["/background"]);
  assert.deepEqual(paths('{"a":1,"a":1}'), ["/a"]); // identical values are still a duplicate
  assert.deepEqual(paths('{"":1,"":2}'), ["/"]);
});

test("dupkeys: the same key in separate objects, siblings, arrays and nesting levels is fine", () => {
  for (const t of ['{"a":{"k":1},"b":{"k":2}}', '[{"k":1},{"k":2}]', '{"k":{"k":{"k":1}}}', '{"a":1,"b":1}', '{"l":[{"k":1},{"k":2}],"m":[{"k":3}]}', "{}", "[]", '{"a":[]}', '{"a":{}}']) assert.deepEqual(paths(t), [], t);
});

test("dupkeys: repeated keys are found at any depth, with a pointer to the repeated key", () => {
  assert.deepEqual(paths('{"o":{"k":1,"k":2}}'), ["/o/k"]);
  assert.deepEqual(paths('{"l":[{"k":1},{"k":1,"k":2}]}'), ["/l/1/k"]);
  assert.deepEqual(paths('{"a":{"x":1},"a":2}'), ["/a"]); // the repeat comes after a nested object closed
  assert.deepEqual(paths('{"a":[1,2,{"z":1}],"a":2}'), ["/a"]);
  assert.deepEqual(paths('{"a":1,"b":{"c":1,"c":2},"b":3}').sort(), ["/b", "/b/c"].sort());
  assert.deepEqual(paths('[[{"k":1,"k":2}]]'), ["/0/0/k"]);
});

test("dupkeys: keys are compared after decoding escapes", () => {
  assert.deepEqual(paths('{"a":1,"\\u0061":2}'), ["/a"]);
  assert.deepEqual(paths('{"\\u0061\\u0062":1,"ab":2}'), ["/ab"]);
  assert.deepEqual(paths('{"a\\"b":1,"a\\u0022b":2}'), ['/a"b']);
  assert.deepEqual(paths('{"a\\\\":1,"a\\\\":2}'), ["/a\\"]); // key is a\ twice
  assert.deepEqual(paths('{"a\\/b":1,"a/b":2}'), ["/a~1b"]);
  assert.deepEqual(paths('{"😀":1,"\\ud83d\\ude00":2}'), ["/😀"]); // literal and surrogate-pair escape
  assert.deepEqual(paths('{"\\u0041":1,"\\u0061":2}'), []); // A and a are different keys
  assert.deepEqual(paths('{"\\u00e9":1,"e\\u0301":2}'), []); // composed vs decomposed are different keys (the strict schema rejects both later)
  assert.deepEqual(paths('{"\\u00e9":1,"é":2}'), ["/é"]); // composed escape vs literal composed
});

test("dupkeys: an escaped backslash before a quote ends the string, an escaped quote does not", () => {
  assert.deepEqual(paths('{"a\\\\":1,"a":2}'), []); // keys "a\" and "a"
  assert.deepEqual(paths('{"a\\"":1,"a":2}'), []); // keys a" and a
  assert.deepEqual(paths('{"a":"x\\\\","a":2}'), ["/a"]); // value ends with a backslash, then a real repeat
});

test("dupkeys: structural characters and key-like text inside strings are not keys", () => {
  assert.deepEqual(paths('{"{":1,"}":2,"[":3,"]":4,",":5,":":6}'), []);
  assert.deepEqual(paths('{"a":"x\\",\\"a\\":1","b":"{\\"a\\":1,\\"a\\":2}"}'), []);
  assert.deepEqual(paths('{"a":["a","a"],"b":"a"}'), []);
  assert.deepEqual(paths('{"a":"{","b":"}","a2":"["}'), []);
});

test("dupkeys: malformed input is reported as malformed, never thrown or accepted", () => {
  for (const t of ['{"a":1,"a"', '{"a', '"\\', '{"a":1}}', "[}", "{]", '{"a":{', "[", "}", '{"a\\u12":1}', '{"a\\q":1,"a\\q":2}']) assert.equal(scanDuplicateKeys(t), "malformed", t);
  assert.deepEqual(scanDuplicateKeys(""), []); // nothing to scan; JSON.parse rejects it earlier
});

test("dupkeys: the scanner never throws on arbitrary characters (deterministic fuzz)", () => {
  let seed = 12345;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const alphabet = ['{', '}', '[', ']', '"', ",", ":", "\\", "a", "b", " ", "u", "0", "\\u0061", '\\"', "é", "😀", "\ud83d"];
  for (let k = 0; k < 3000; k++) {
    let t = "";
    for (let j = rnd(40); j > 0; j--) t += alphabet[rnd(alphabet.length)];
    const r = scanDuplicateKeys(t);
    assert.ok(r === "malformed" || Array.isArray(r));
  }
});

test("dupkeys: agreement with JSON.parse on random valid documents (a repeat means fewer keys survive parsing)", () => {
  let seed = 99;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  const names = ["a", "b", "\\u0061", "c\\\\", "c\\u005c", "d\\\"", "d\\u0022", "é", ""];
  const obj = (d: number): { text: string; repeats: boolean } => {
    let repeats = false;
    const seen = new Set<string>();
    const parts: string[] = [];
    for (let j = rnd(5); j > 0; j--) {
      const name = names[rnd(names.length)]!;
      const decoded = JSON.parse(`"${name}"`) as string;
      if (seen.has(decoded)) repeats = true;
      seen.add(decoded);
      let v = "1";
      if (d < 3 && rnd(3) === 0) {
        const sub = obj(d + 1);
        v = sub.text;
        repeats = repeats || sub.repeats;
      } else if (rnd(4) === 0) v = '"s"';
      parts.push(`"${name}":${v}`);
    }
    return { text: `{${parts.join(",")}}`, repeats };
  };
  for (let k = 0; k < 500; k++) {
    const { text, repeats } = obj(0);
    JSON.parse(text);
    const r = scanDuplicateKeys(text);
    assert.ok(Array.isArray(r), text);
    assert.equal((r as unknown[]).length > 0, repeats, text);
  }
});

test("dupkeys: deep and large inputs are scanned iteratively and stay bounded", () => {
  const deep = "[".repeat(100_000) + "]".repeat(100_000); // would overflow a recursive scanner
  assert.deepEqual(scanDuplicateKeys(deep), []);
  assert.equal(scanDuplicateKeys("[".repeat(100_000)), "malformed");
  const many = `{${Array.from({ length: 5000 }, () => '"k":1').join(",")}}`;
  const r = scanDuplicateKeys(many) as unknown[];
  assert.equal(r.length, 50); // issue list is capped
  const longKey = "k".repeat(400);
  const lk = scanDuplicateKeys(`{"${longKey}":1,"${longKey}":2}`) as Array<{ path: string; message: string }>;
  assert.ok(lk[0]!.path.length <= 50, "long key names are clipped in the pointer");
  assert.ok(!lk[0]!.message.includes("kkkk"));
});

test("dupkeys: parseSpecText rejects a duplicate as a parse_error, with no spec and no hash", () => {
  const dup = exampleText.replace('"name": "Expense dashboard"', '"name": "Innocent first value", "name": "Expense dashboard"');
  assert.notEqual(dup, exampleText);
  for (const t of [dup, exampleText.replace('"name": "Expense dashboard"', '"name": "Expense dashboard", "name": "Last value"'), exampleText.replace('"name": "Expense dashboard"', '"name": "x", "n\\u0061me": "Expense dashboard"')]) {
    const r = parseSpecText(t) as any;
    assert.equal(r.ok, false);
    assert.equal(r.kind, "parse_error");
    assert.deepEqual(r.issues.map((i: any) => [i.code, i.path]), [["duplicate_key", "/screen/name"]]);
    assert.ok(!("spec" in r) && !("hash" in r));
    assert.ok(!JSON.stringify(r).includes("Innocent") && !JSON.stringify(r).includes("Last value"));
  }
});

test("dupkeys: a duplicate that the schema would also reject is reported as a duplicate first, and the boundary depths still behave", () => {
  const r = parseSpecText('{"schemaVersion":1,"schemaVersion":2}') as any;
  assert.equal(r.issues[0].code, "duplicate_key");
  const nest = (d: number, inner: string) => '{"a":'.repeat(d) + inner + "}".repeat(d);
  const atLimit = parseSpecText(nest(LIMITS.rawJsonDepth, "1")) as any; // at the raw depth limit: passes the scanner and reaches the schema stage
  assert.equal(atLimit.kind, "schema_error");
  assert.equal((parseSpecText(nest(LIMITS.rawJsonDepth + 1, "1")) as any).issues[0].code, "too_complex");
  assert.equal((parseSpecText(nest(LIMITS.rawJsonDepth - 1, '{"k":1,"k":2}')) as any).issues[0].code, "duplicate_key"); // duplicate at the deepest allowed level
  const huge = "[".repeat(30_000) + "]".repeat(30_000);
  assert.equal((parseSpecText(huge) as any).issues[0].code, "too_complex"); // parse limit still wins, scanner not needed
});

test("dupkeys: valid documents keep the same normalized output and hash regardless of whitespace or key order", () => {
  const base = parseSpecText(exampleText) as any;
  assert.equal(base.ok, true);
  assert.equal(base.hash, EXAMPLE_HASH);
  const compact = parseSpecText(JSON.stringify(JSON.parse(exampleText))) as any;
  const wide = parseSpecText(JSON.stringify(JSON.parse(exampleText), null, 11)) as any;
  const reorder = (v: any): any => (Array.isArray(v) ? v.map(reorder) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reorder(v[k])])) : v);
  const reversed = parseSpecText(JSON.stringify(reorder(JSON.parse(exampleText)))) as any;
  for (const r of [compact, wide, reversed]) {
    assert.equal(r.ok, true);
    assert.equal(r.hash, EXAMPLE_HASH);
    assert.equal(specHash(r.spec), EXAMPLE_HASH);
    assert.deepEqual(r.spec, base.spec);
  }
  assert.equal((validateSpec(JSON.parse(exampleText)) as any).hash, EXAMPLE_HASH); // already-parsed values are unaffected
});

test("dupkeys: the CLI file path reports the duplicate the same way", () => {
  const dir = tmp("dup");
  const p = join(dir, "dup.json");
  writeFileSync(p, exampleText.replace('"name": "Expense dashboard"', '"name": "a", "name": "Expense dashboard"'));
  const out = validateFile(p);
  assert.equal(out.report.valid, false);
  assert.equal((out.report as any).kind, "parse_error");
  assert.equal((out.report as any).issues[0].code, "duplicate_key");
  assert.equal(out.exit, 1);
});

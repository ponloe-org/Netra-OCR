// Tests for src/cors.ts. Run from the repository root: node --no-warnings --test tests/cors.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOriginList, resolveCorsOrigin } from "../src/cors.ts";

test("no configuration means no cross-origin access", () => {
  assert.deepEqual(parseOriginList(undefined), []);
  assert.deepEqual(parseOriginList("   "), []);
  assert.equal(resolveCorsOrigin("http://localhost:3000", []), null);
});

test("origins are parsed, trimmed, normalised and de-duplicated", () => {
  assert.deepEqual(
    parseOriginList(" https://App.Example/ , http://localhost:3000,https://app.example"),
    ["https://app.example", "http://localhost:3000"]
  );
});

test("a wildcard is refused", () => {
  assert.throws(() => parseOriginList("*"), /'\*' is not allowed/);
  assert.throws(() => parseOriginList("https://a.example, *"), /'\*' is not allowed/);
});

test("entries must be bare http or https origins", () => {
  assert.throws(() => parseOriginList("not a url"), /invalid origin/);
  assert.throws(() => parseOriginList("ftp://files.example"), /http or https/);
  assert.throws(() => parseOriginList("https://a.example/app"), /bare origins/);
  assert.throws(() => parseOriginList("https://a.example?x=1"), /bare origins/);
});

test("only a listed origin is echoed back", () => {
  const allowed = parseOriginList("http://localhost:3000");
  assert.equal(resolveCorsOrigin("http://localhost:3000", allowed), "http://localhost:3000");
  assert.equal(resolveCorsOrigin("http://localhost:3001", allowed), null);
  assert.equal(resolveCorsOrigin("https://localhost:3000", allowed), null, "scheme must match");
  assert.equal(resolveCorsOrigin(undefined, allowed), null);
  assert.equal(resolveCorsOrigin("null", allowed), null, "opaque origins are not allowed");
});

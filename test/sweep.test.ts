import assert from "node:assert/strict";
import test from "node:test";
import { sweepToSingleLine, messagePayload } from "../src/message.js";
import { ProtocolError } from "../src/errors.js";

/**
 * Conformance vectors for the server's clean_text (store.py):
 *   INVISIBLE_CATEGORIES = ("Cc","Cf","Cs","Co","Zl","Zp"), swept to a space,
 *   then .strip(). Zs is deliberately NOT in that tuple, so NBSP survives.
 * Reported by @Orvynel in issue #1; verified here against the server source.
 */
const VECTORS: Array<[name: string, input: string, want: string]> = [
  ["leading-trailing-trimmed", "  padded  ", "padded"],
  ["swept-then-trimmed", "\nhi\n", "hi"],
  ["bom-Cf", "\uFEFFhi", "hi"],
  ["private-use-Co", "a\uE000b", "a b"],
  ["mongolian-vowel-separator", "a\u180Eb", "a b"],
  ["soft-hyphen-Cf", "co\u00ADoperate", "co operate"],
  ["rtl-mark-Cf", "\u200Fmarker", "marker"],
  ["zero-width-joiner", "a\u200Db", "a b"],
  ["bidi-isolate", "a\u2066b\u2069c", "a b c"],
  ["line-separator-Zl", "a\u2028b", "a b"],
  ["paragraph-separator-Zp", "a\u2029b", "a b"],
  ["tag-characters", "\u{1F3F4}\u{E0067}\u{E0062}", "\u{1F3F4}"],
  ["plain-text-untouched", "hello world", "hello world"],
  ["astral-survives", "rocket \u{1F680} here", "rocket \u{1F680} here"],
];

for (const [name, input, want] of VECTORS) {
  test(`sweep: ${name}`, () => {
    assert.equal(sweepToSingleLine(input), want);
  });
}

test("sweep: NBSP survives in the middle — the server keeps Zs", () => {
  assert.equal(sweepToSingleLine("a\u00A0b"), "a\u00A0b");
});

test("sweep: NBSP at the edges is trimmed, matching the server", () => {
  // Zs is not swept, but both JS .trim() and Python .strip() remove NBSP at
  // the edges — so the two implementations agree here despite differing on
  // which code points they each consider trimmable in the abstract.
  assert.equal(sweepToSingleLine("\u00A0hi\u00A0"), "hi");
});

test("sweep: all-invisible input reaches the empty guard", () => {
  assert.equal(sweepToSingleLine("\u200B\u200D\uFEFF"), "");
  assert.throws(() => messagePayload("lobby", "1", "\u200B\u200D\uFEFF"), ProtocolError);
});

test("sweep is idempotent", () => {
  for (const [, input] of VECTORS) {
    const once = sweepToSingleLine(input);
    assert.equal(sweepToSingleLine(once), once);
  }
});

test("payload signs the swept text, not the raw text", () => {
  const built = messagePayload("lobby", "1", "  co\u00ADoperate  ");
  assert.equal(built.text, "co operate");
  assert.equal(built.payload.toString("utf8"), "lobby|1|co operate");
});

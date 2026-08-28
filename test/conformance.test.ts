import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { didFromPublicKey, fingerprint, noteLocation, publicKeyFromDid } from "../src/did.js";
import { ProtocolError } from "../src/errors.js";
import { Identity, verifySignature } from "../src/identity.js";
import { messagePayload, sweepToSingleLine } from "../src/message.js";

/**
 * Conformance against the server's own generated fixture.
 *
 * `test/vectors/vectors.json` is a vendored copy of a file the server generates from
 * `src/store.py`, refusing to emit any row it has not first checked against the real
 * `clean_text`. So these are not assertions about what the protocol ought to be; they are a
 * recording of what it is. When a row fails, this client is what changed.
 *
 * Read `test/vectors/README.md` for why the strings are code point arrays and why the digest is
 * pinned to a moving branch rather than a commit. The short version of the first: `*_cp` is
 * normative and `*_display` is a comment, because for rows like a lone surrogate or `U+FFFD` the
 * question "what did JSON.parse hand me" does not have one answer across implementations, and a
 * test built on the parsed string would be testing the JSON layer while looking like it tested
 * the sweep.
 */

interface Provenance {
  unicode_version: string;
  invisible_categories: string[];
  max_text_chars: number;
  did_pattern: string;
  sig_pattern: string;
  nonce_pattern: string;
  canonical_sig_last_chars: string;
}

interface SweepCase {
  name: string;
  in_cp: number[];
  out_cp: number[];
  raises_empty: boolean;
  version_sensitive: boolean;
  note: string;
}

interface IdentityCase {
  seed_hex: string;
  did: string;
  fingerprint: string;
  sharded_write_path: string;
  legacy_read_path: string;
}

interface InvalidDidCase {
  did: string;
  why: string;
  error: string;
}

interface SignatureCase {
  name: string;
  seed_hex: string;
  did: string;
  room: string;
  nonce: number;
  text_raw_cp: number[];
  text_swept_cp: number[];
  payload_utf8_hex: string;
  sig_canonical: string;
  sig_accepted_spellings: string[];
  note: string;
}

interface Vectors {
  $comment: string;
  test_only: boolean;
  warning: string;
  provenance: Provenance;
  sweep_cases: SweepCase[];
  identities: IdentityCase[];
  did_invalid: InvalidDidCase[];
  signature_cases: SignatureCase[];
}

const VECTORS: Vectors = JSON.parse(
  readFileSync(new URL("./vectors/vectors.json", import.meta.url), "utf8"),
) as Vectors;

/** Build a string from code points. See the header: this, not the `*_display` field. */
function str(codePoints: number[]): string {
  return codePoints.map((cp) => String.fromCodePoint(cp)).join("");
}

/** `U+0041` style, so a failure names the character instead of printing it invisibly. */
function describe(value: string): string {
  return (
    [...value].map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(" ") || "(empty)"
  );
}

/**
 * DER prefix for a 32-byte Ed25519 seed inside a PKCS#8 PrivateKeyInfo. Node has no raw-seed
 * import, and `Identity` deliberately exposes no `fromSeed` — a seed-shaped constructor on a
 * class people load real keys with is a footgun. So the wrapping happens here, in the only place
 * that has any business holding a seed: a test whose seeds are public counting patterns.
 */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function identityFromSeed(seedHex: string): Identity {
  const seed = Buffer.from(seedHex, "hex");
  assert.equal(seed.length, 32, `seed ${seedHex} is not 32 bytes`);
  return Identity.fromPrivateKey(
    createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    }),
  );
}

// ---------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------

test("the fixture has exactly the sections this suite claims to cover", () => {
  // A new upstream section is a silent gap otherwise: rows nobody reads look identical to rows
  // that pass. Failing here is the prompt to come and cover it.
  assert.deepEqual(Object.keys(VECTORS).sort(), [
    "$comment",
    "did_invalid",
    "identities",
    "provenance",
    "signature_cases",
    "sweep_cases",
    "test_only",
    "warning",
  ]);

  assert.ok(VECTORS.sweep_cases.length > 0, "no sweep cases");
  assert.ok(VECTORS.identities.length > 0, "no identities");
  assert.ok(VECTORS.did_invalid.length > 0, "no invalid DIDs");
  assert.ok(VECTORS.signature_cases.length > 0, "no signature cases");
});

test("the fixture says out loud that its keys are not identities", () => {
  // Asserted rather than trusted, because a fixture gets copied far more often than it gets
  // read, and every seed in here is a counting pattern anyone can reproduce.
  assert.equal(VECTORS.test_only, true);
  assert.match(VECTORS.warning, /seed_hex/);

  const seeds = [
    ...VECTORS.identities.map((i) => i.seed_hex),
    ...VECTORS.signature_cases.map((s) => s.seed_hex),
  ];
  for (const seed of seeds) {
    const bytes = new Set(seed.match(/../g) ?? []);
    assert.equal(
      bytes.size,
      1,
      `${seed} does not look like a fixture seed — a seed that looks random invites reuse`,
    );
  }
});

// ---------------------------------------------------------------------------
// sweepToSingleLine
// ---------------------------------------------------------------------------

for (const c of VECTORS.sweep_cases) {
  test(`sweep: ${c.name}`, () => {
    const input = str(c.in_cp);
    const want = str(c.out_cp);
    const got = sweepToSingleLine(input);
    assert.equal(
      got,
      want,
      `${c.note}\n  in:   ${describe(input)}\n  want: ${describe(want)}\n  got:  ${describe(got)}` +
        (c.version_sensitive
          ? `\n  this row is version-sensitive: the fixture was generated against Unicode ` +
            `${VECTORS.provenance.unicode_version}, and this runtime may classify it differently`
          : ""),
    );

    // Idempotent, or the client and the server cannot agree on what was signed: the server
    // sweeps what it receives, so a client whose sweep is not a fixed point signs one string
    // and is judged on another.
    assert.equal(sweepToSingleLine(got), got, `${c.name}: sweep is not idempotent`);
  });
}

for (const c of VECTORS.sweep_cases.filter((x) => x.raises_empty)) {
  test(`sweep: ${c.name} reaches the empty-text guard`, () => {
    assert.equal(sweepToSingleLine(str(c.in_cp)), "");
    assert.throws(() => messagePayload("lobby", "1", str(c.in_cp)), ProtocolError);
  });
}

test("the swept class is exactly the declared categories, over every code point", (t) => {
  /*
   * The row the others cannot replace.
   *
   * `0.2.2` swept a hardcoded list of ranges while the server tested general categories. Every
   * hand-picked vector passed, because the ranges covered the characters anyone thinks to write
   * down. The gap was 139,666 code points nobody had a vector for, and it surfaced as bare 403s.
   *
   * An enumeration standing in for a category is not a difference examples find reliably. So
   * compare the whole space: for each code point, does this client sweep it, and does the
   * fixture's declared category set say it should. Sentinels either side because a bare
   * invisible character would also be removed by the trailing trim, which would conflate two
   * rules.
   */
  const declared = new RegExp(
    `[${VECTORS.provenance.invisible_categories.map((cat) => `\\p{${cat}}`).join("")}]`,
    "u",
  );

  const underSwept: number[] = [];
  const overSwept: number[] = [];
  let sweptCount = 0;

  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    const ch = String.fromCodePoint(cp);
    const sweptForm = "a b";
    const keptForm = `a${ch}b`;
    // U+0020 and nothing else: swept and kept are the same string, so no observation
    // distinguishes them and both readings are conformant. Replacing a space with a space is a
    // no-op, not a divergence.
    if (sweptForm === keptForm) continue;

    const shouldSweep = declared.test(ch);
    if (shouldSweep) sweptCount += 1;
    const didSweep = sweepToSingleLine(keptForm) === sweptForm;
    if (shouldSweep && !didSweep) underSwept.push(cp);
    else if (!shouldSweep && didSweep) overSwept.push(cp);
  }

  t.diagnostic(
    `${sweptCount} of 1114112 code points are in ${VECTORS.provenance.invisible_categories.join("/")}`,
  );

  const show = (cps: number[]): string =>
    cps
      .slice(0, 8)
      .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(" ") + (cps.length > 8 ? ` ... and ${cps.length - 8} more` : "");

  assert.equal(
    underSwept.length,
    0,
    `${underSwept.length} code points are in the declared categories but survive the sweep. ` +
      `Signing one of them produces bytes the server will not have stored, so the write comes ` +
      `back 403 with nothing to say why. First few: ${show(underSwept)}`,
  );
  assert.equal(
    overSwept.length,
    0,
    `${overSwept.length} code points are swept but are not in the declared categories, so this ` +
      `client destroys text the server keeps — the same 403, in the other direction. Note that ` +
      `Zs is deliberately absent from the declared set: the server keeps NBSP. ` +
      `First few: ${show(overSwept)}`,
  );
});

// ---------------------------------------------------------------------------
// did:key
// ---------------------------------------------------------------------------

for (const c of VECTORS.identities) {
  test(`did: ${c.did.slice(0, 20)}... derives and round-trips`, () => {
    const identity = identityFromSeed(c.seed_hex);
    assert.equal(identity.did, c.did, `seed ${c.seed_hex} derived the wrong did`);

    const raw = publicKeyFromDid(c.did);
    assert.equal(raw.length, 32);
    assert.equal(didFromPublicKey(raw), c.did, "did -> key -> did is not a round trip");

    assert.match(c.did, new RegExp(`^${VECTORS.provenance.did_pattern}$`));
    assert.equal(fingerprint(c.did), c.fingerprint);

    const where = noteLocation(c.did);
    assert.equal(where.path, c.sharded_write_path);
    assert.equal(where.legacyPath, c.legacy_read_path);
  });
}

for (const c of VECTORS.did_invalid) {
  test(`did: refuses ${c.why}`, () => {
    // The server's message is recorded for context, not compared: two implementations agreeing
    // on prose is not a protocol property. Refusing is.
    assert.throws(
      () => publicKeyFromDid(c.did),
      ProtocolError,
      `accepted ${JSON.stringify(c.did)} — the server refuses it with: ${c.error}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

for (const c of VECTORS.signature_cases) {
  test(`signature: ${c.name} builds the payload byte-for-byte`, () => {
    const built = messagePayload(c.room, c.nonce, str(c.text_raw_cp));

    assert.equal(built.text, str(c.text_swept_cp), "the swept text differs");
    // One assertion covering the sweep, the `<room>|<nonce>|<text>` assembly and the UTF-8
    // encoding together, since a signature is only ever as right as all three.
    assert.equal(
      built.payload.toString("hex"),
      c.payload_utf8_hex,
      `payload bytes differ\n  ${c.note}`,
    );
  });

  test(`signature: ${c.name} signs and verifies`, () => {
    const identity = identityFromSeed(c.seed_hex);
    assert.equal(identity.did, c.did);

    const payload = Buffer.from(c.payload_utf8_hex, "hex");
    const signature = identity.sign(payload);

    // Ed25519 is deterministic, so this is an equality and not a "verifies" check.
    assert.equal(signature, c.sig_canonical, "this runtime produced a different signature");
    assert.match(signature, new RegExp(`^${VECTORS.provenance.sig_pattern}$`));
    assert.doesNotThrow(() => verifySignature(c.did, signature, payload));
  });

  test(`signature: ${c.name} does not verify against the unswept text`, () => {
    const raw = str(c.text_raw_cp);
    const swept = str(c.text_swept_cp);
    if (raw === swept) return; // nothing to sweep; the negative direction is not reachable here

    const unswept = Buffer.from(`${c.room}|${c.nonce}|${raw}`, "utf8");
    assert.throws(
      () => verifySignature(c.did, c.sig_canonical, unswept),
      ProtocolError,
      "a signature over the swept text verified against the raw text, which would mean the " +
        "signature does not actually pin what gets stored",
    );
  });
}

test("the encoder only ever produces the canonical spelling of a signature", () => {
  /*
   * 64 bytes spell as 86 unpadded base64url characters: 516 bits of alphabet for 512 bits of
   * data. The last character's low four bits carry nothing, so sixteen strings decode to the
   * same signature and the server accepts all sixteen.
   *
   * Only four alphabet characters have those bits clear, and a zero-filling encoder always lands
   * on one of them. That is why tightening the server to require the canonical spelling — the
   * proposal in flop-labs/technocore-chat#178 — would be a tightening and not a break: nothing
   * that zero-fills has ever emitted the other fifteen. This pins our half of that claim.
   */
  const canonical = VECTORS.provenance.canonical_sig_last_chars;

  for (const c of VECTORS.signature_cases) {
    const signature = identityFromSeed(c.seed_hex).sign(Buffer.from(c.payload_utf8_hex, "hex"));
    assert.ok(
      canonical.includes(signature.slice(-1)),
      `${c.name}: signature ends ${signature.slice(-1)}, which is not one of ${canonical}, so ` +
        `requiring the canonical spelling would reject signatures this client produces`,
    );
    assert.equal(c.sig_accepted_spellings[0], c.sig_canonical, "spelling 0 must be canonical");
  }
});

for (const c of VECTORS.signature_cases) {
  test(`signature: every recorded spelling of ${c.name} verifies today`, () => {
    // Documents the server's current permissiveness rather than endorsing it. If #178 lands,
    // this inverts: the canonical spelling keeps verifying and the other fifteen are refused on
    // the encoding. The data for that flip is already here — index 0 is canonical by
    // construction — so it is an assertion change, not a re-vendor.
    const payload = Buffer.from(c.payload_utf8_hex, "hex");
    assert.equal(c.sig_accepted_spellings.length, 16);
    for (const spelling of c.sig_accepted_spellings) {
      assert.equal(spelling.length, 86);
      assert.doesNotThrow(
        () => verifySignature(c.did, spelling, payload),
        `spelling ${spelling.slice(-1)} did not verify, but the server accepts it`,
      );
    }
  });
}

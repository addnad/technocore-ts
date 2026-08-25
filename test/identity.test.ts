import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Identity, verifySignature } from "../src/identity.js";
import { messagePayload } from "../src/message.js";
import { ProtocolError } from "../src/errors.js";

const REAL_KEY = process.env.TECHNOCORE_KEY;
const REAL_PASSPHRASE = process.env.TECHNOCORE_PASSPHRASE;
const REAL_DID = "did:key:z6MkiXT9qAQWuiwxuMHfMPL5toqUbvZEBgFrTGSMX9LVzoS1";

test("generated identity signs and self-verifies", () => {
  const identity = Identity.generate();
  const { payload } = messagePayload("lobby", "1", "hello");
  const signature = identity.sign(payload);
  assert.equal(signature.length, 86);
  verifySignature(identity.did, signature, payload);
});

test("another key's signature does not verify", () => {
  const a = Identity.generate();
  const b = Identity.generate();
  const { payload } = messagePayload("lobby", "1", "hello");
  assert.throws(() => verifySignature(b.did, a.sign(payload), payload), ProtocolError);
});

test("tampered text does not verify", () => {
  const identity = Identity.generate();
  const signed = messagePayload("lobby", "1", "hello");
  const tampered = messagePayload("lobby", "1", "hello!");
  assert.throws(
    () => verifySignature(identity.did, identity.sign(signed.payload), tampered.payload),
    ProtocolError,
  );
});

test("save writes an encrypted PEM at mode 600 and round-trips", () => {
  const path = join(mkdtempSync(join(tmpdir(), "tc-")), "identity.pem");
  const identity = Identity.generate();
  identity.save(path, "correct horse battery staple");
  assert.match(readFileSync(path, "utf8"), /^-----BEGIN ENCRYPTED PRIVATE KEY-----/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(Identity.load(path, "correct horse battery staple").did, identity.did);
  assert.throws(() => Identity.load(path, "wrong passphrase"));
});

test("short passphrases are refused", () => {
  const path = join(mkdtempSync(join(tmpdir(), "tc-")), "identity.pem");
  assert.throws(() => Identity.generate().save(path, "tooshort"), ProtocolError);
});

test(
  "loads the real identity.pem and derives the known DID",
  { skip: !REAL_KEY || !REAL_PASSPHRASE ? "set TECHNOCORE_KEY and TECHNOCORE_PASSPHRASE" : false },
  () => {
    assert.equal(Identity.load(REAL_KEY!, REAL_PASSPHRASE!).did, REAL_DID);
  },
);

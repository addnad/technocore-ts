import assert from "node:assert/strict";
import test from "node:test";
import {
  base58btcDecode,
  base58btcEncode,
  didFromPublicKey,
  fingerprint,
  noteLocation,
  publicKeyFromDid,
} from "../src/did.js";
import { ProtocolError } from "../src/errors.js";

const DID = "did:key:z6MkiXT9qAQWuiwxuMHfMPL5toqUbvZEBgFrTGSMX9LVzoS1";
const FINGERPRINT = "1f0e7976ce2c74da";

test("did decodes to a 32-byte Ed25519 key and re-derives itself", () => {
  const raw = publicKeyFromDid(DID);
  assert.equal(raw.length, 32);
  assert.equal(didFromPublicKey(raw), DID);
});

test("fingerprint matches the value shasum produced", () => {
  assert.equal(fingerprint(DID), FINGERPRINT);
});

test("note location matches the path the server accepted", () => {
  const location = noteLocation(DID);
  assert.equal(location.shard, "1f");
  assert.equal(location.key, "0e7976ce2c74da");
  assert.equal(location.path, "/kv/did-1f/0e7976ce2c74da");
  assert.equal(location.legacyPath, `/kv/did/${FINGERPRINT}`);
});

test("base58btc round-trips, leading zeros included", () => {
  for (const bytes of [
    Uint8Array.from([0, 0, 1, 2, 3]),
    Uint8Array.from([0]),
    Uint8Array.from([255, 255, 255]),
  ]) {
    assert.deepEqual(base58btcDecode(base58btcEncode(bytes)), bytes);
  }
});

test("rejects non-Ed25519 and malformed input", () => {
  assert.throws(() => publicKeyFromDid("did:key:zNotEd25519"), ProtocolError);
  assert.throws(() => publicKeyFromDid(DID.replace("did:key:z", "did:web:")), ProtocolError);
  assert.throws(() => didFromPublicKey(new Uint8Array(31)), ProtocolError);
  assert.throws(() => base58btcDecode("0OIl"), ProtocolError);
});

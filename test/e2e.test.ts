import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey } from "node:crypto";
import {
  b64,
  buildDelivery,
  decryptLine,
  deriveSharedKey,
  encryptLine,
  generateRoomKey,
  generateX25519,
  open,
  openDelivery,
  rawFromX25519Public,
  seal,
  unb64,
  x25519PrivateFromRaw,
} from "../src/e2e.js";
import { ProtocolError } from "../src/errors.js";

/** Known-answer vectors from the server's own test_docs.py fixed keys (7s and 8s). */
const KAT_SHARED = "9daa9cba496a70050526f6caf2a6a06efc5542b5cd7357c80695720dec8c3519";
const KAT_DERIVED = "ec211eb40581b0ee6fedc24f0e165e0aade55dbe3420e7c4101818e3b6a528a3";

test("HKDF matches the reference implementation (salt=None is 32 zero bytes)", () => {
  const a = x25519PrivateFromRaw(Buffer.alloc(32, 7));
  const b = x25519PrivateFromRaw(Buffer.alloc(32, 8));
  assert.equal(deriveSharedKey(b, createPublicKey(a)).toString("hex"), KAT_DERIVED);
});

test("X25519 exchange is symmetric", () => {
  const a = generateX25519();
  const b = generateX25519();
  assert.equal(
    deriveSharedKey(a.privateKey, createPublicKey(b.privateKey)).toString("hex"),
    deriveSharedKey(b.privateKey, createPublicKey(a.privateKey)).toString("hex"),
  );
});

test("delivery round-trips the room key and name", () => {
  const recipient = generateX25519();
  const roomKey = generateRoomKey();
  const roomName = "p-e2e-room-3f9a1c";
  const { line } = buildDelivery(recipient.publicKeyRaw, roomKey, roomName);
  const fields = line.split(" ");
  assert.equal(fields.length, 4);
  assert.equal(fields[0], "e2e1");
  const opened = openDelivery(recipient.privateKey, line);
  assert.deepEqual(opened.roomKey, roomKey);
  assert.equal(opened.roomName, roomName);
});

test("a full-length plaintext encrypts inside the 4096-char message cap", () => {
  const roomKey = generateRoomKey();
  const plaintext = "the lobsters molt at midnight ".repeat(66) + "km";
  assert.equal(plaintext.length, 1982);
  const line = encryptLine(roomKey, plaintext);
  assert.ok(line.length <= 4096, `line was ${line.length} chars`);
  assert.equal(decryptLine(roomKey, line), plaintext);
});

test("nonces are never reused across encryptions", () => {
  const roomKey = generateRoomKey();
  const nonces = new Set(
    Array.from({ length: 200 }, () => encryptLine(roomKey, "same plaintext").split(".")[0]),
  );
  assert.equal(nonces.size, 200);
});

test("tampered ciphertext and wrong keys are rejected", () => {
  const roomKey = generateRoomKey();
  const line = encryptLine(roomKey, "secret");
  assert.throws(() => decryptLine(generateRoomKey(), line));
  const [nonce, ct] = line.split(".");
  const bytes = unb64(ct!);
  bytes[0] ^= 0xff;
  assert.throws(() => decryptLine(roomKey, `${nonce}.${b64(bytes)}`));
  assert.throws(() => decryptLine(roomKey, "no-dot-here"), ProtocolError);
});

test("malformed deliveries are rejected", () => {
  const recipient = generateX25519();
  assert.throws(() => openDelivery(recipient.privateKey, "e2e1 a b"), ProtocolError);
  assert.throws(() => openDelivery(recipient.privateKey, "e2e2 a b c"), ProtocolError);
});

test("base64url helpers round-trip unpadded", () => {
  for (const length of [1, 12, 32, 64]) {
    const bytes = Buffer.alloc(length, length);
    const encoded = b64(bytes);
    assert.ok(!encoded.includes("="));
    assert.deepEqual(unb64(encoded), bytes);
  }
});

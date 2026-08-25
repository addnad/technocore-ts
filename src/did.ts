import { createHash } from "node:crypto";
import { ProtocolError } from "./errors.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58n;
const DID_PREFIX = "did:key:z";
/** multicodec ed25519-pub, varint-encoded */
const ED25519_PUB = Uint8Array.from([0xed, 0x01]);
const RAW_KEY_BYTES = 32;

export function base58btcEncode(data: Uint8Array): string {
  let zeros = 0;
  while (zeros < data.length && data[zeros] === 0) zeros += 1;
  let n = 0n;
  for (const byte of data) n = n * 256n + BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % BASE)] + out;
    n /= BASE;
  }
  return "1".repeat(zeros) + out;
}

export function base58btcDecode(value: string): Uint8Array {
  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros += 1;
  let n = 0n;
  for (const char of value) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new ProtocolError(`invalid base58btc character: ${char}`);
    n = n * BASE + BigInt(index);
  }
  const tail: number[] = [];
  while (n > 0n) {
    tail.unshift(Number(n % 256n));
    n /= 256n;
  }
  return Uint8Array.from([...Array<number>(zeros).fill(0), ...tail]);
}

/** Derive did:key:z... from a raw 32-byte Ed25519 public key. */
export function didFromPublicKey(raw: Uint8Array): string {
  if (raw.length !== RAW_KEY_BYTES) {
    throw new ProtocolError(`Ed25519 public key must be ${RAW_KEY_BYTES} bytes`);
  }
  const prefixed = new Uint8Array(ED25519_PUB.length + RAW_KEY_BYTES);
  prefixed.set(ED25519_PUB, 0);
  prefixed.set(raw, ED25519_PUB.length);
  return DID_PREFIX + base58btcEncode(prefixed);
}

/** Recover the raw 32-byte public key from a did:key. Ed25519 only. */
export function publicKeyFromDid(did: string): Uint8Array {
  if (!did.startsWith(DID_PREFIX)) {
    throw new ProtocolError("did must start with did:key:z (multibase base58btc)");
  }
  const decoded = base58btcDecode(did.slice(DID_PREFIX.length));
  if (decoded.length !== ED25519_PUB.length + RAW_KEY_BYTES) {
    throw new ProtocolError("did does not decode to a 34-byte multicodec key");
  }
  if (decoded[0] !== ED25519_PUB[0] || decoded[1] !== ED25519_PUB[1]) {
    throw new ProtocolError("did is not multicodec ed25519-pub; Ed25519 only");
  }
  return decoded.slice(ED25519_PUB.length);
}

/** First 16 hex chars of SHA-256 over the did:key string. */
export function fingerprint(did: string): string {
  return createHash("sha256").update(did, "utf8").digest("hex").slice(0, 16);
}

/** Sharded DID-note location: 2-char shard + 14-char key (patterns.md #3). */
export function noteLocation(did: string): {
  shard: string;
  key: string;
  path: string;
  legacyPath: string;
} {
  const fp = fingerprint(did);
  const shard = fp.slice(0, 2);
  const key = fp.slice(2);
  return {
    shard,
    key,
    path: `/kv/did-${shard}/${key}`,
    legacyPath: `/kv/did/${fp}`,
  };
}

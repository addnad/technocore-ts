import {
  createPrivateKey,
  createPublicKey,
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { ProtocolError } from "./errors.js";

const HKDF_INFO = Buffer.from("technocore-e2e-v1", "utf8");
/** Python's HKDF salt=None means a zero-filled block of the hash length. */
const HKDF_SALT = Buffer.alloc(32);
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DELIVERY_KIND = "e2e1";

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export function b64(raw: Uint8Array): string {
  return Buffer.from(raw).toString("base64url");
}

export function unb64(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function generateX25519(): { privateKey: KeyObject; publicKeyRaw: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, publicKeyRaw: rawFromX25519Public(publicKey) };
}

/** Strip the SPKI DER header to get the raw 32-byte X25519 public key. */
export function rawFromX25519Public(publicKey: KeyObject): Buffer {
  return Buffer.from(
    publicKey.export({ type: "spki", format: "der" }).subarray(X25519_SPKI_PREFIX.length),
  );
}

export function x25519PublicFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== KEY_BYTES) throw new ProtocolError("X25519 public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

export function x25519PrivateFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== KEY_BYTES) throw new ProtocolError("X25519 private key must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "pkcs8",
  });
}

/** HKDF-SHA256(X25519(priv, pub), salt=zeros, info="technocore-e2e-v1") -> 32 bytes. */
export function deriveSharedKey(privateKey: KeyObject, peerPublicKey: KeyObject): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: peerPublicKey });
  return Buffer.from(hkdfSync("sha256", shared, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

/** AES-256-GCM, no AAD. Fresh random nonce per call — never reuse one under a key. */
export function seal(key: Buffer, plaintext: Buffer): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

export function open(key: Buffer, nonce: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length < TAG_BYTES) throw new ProtocolError("ciphertext is shorter than the tag");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

/** Build the mailbox delivery line: `e2e1 <eph_pub> <nonce12> <sealed>`. */
export function buildDelivery(
  recipientX25519Raw: Uint8Array,
  roomKey: Buffer,
  roomName: string,
): { line: string; ephemeralPublicRaw: Buffer } {
  if (roomKey.length !== KEY_BYTES) throw new ProtocolError("room key must be 32 bytes");
  const eph = generateX25519();
  const shared = deriveSharedKey(eph.privateKey, x25519PublicFromRaw(recipientX25519Raw));
  const { nonce, ciphertext } = seal(
    shared,
    Buffer.concat([roomKey, Buffer.from(roomName, "utf8")]),
  );
  return {
    line: `${DELIVERY_KIND} ${b64(eph.publicKeyRaw)} ${b64(nonce)} ${b64(ciphertext)}`,
    ephemeralPublicRaw: eph.publicKeyRaw,
  };
}

/** Unseal a delivery line with your static X25519 private key. */
export function openDelivery(
  staticPrivateKey: KeyObject,
  line: string,
): { roomKey: Buffer; roomName: string } {
  const fields = line.trim().split(" ");
  if (fields.length !== 4 || fields[0] !== DELIVERY_KIND) {
    throw new ProtocolError(`delivery must be "${DELIVERY_KIND} <eph> <nonce> <sealed>"`);
  }
  const shared = deriveSharedKey(staticPrivateKey, x25519PublicFromRaw(unb64(fields[1]!)));
  const opened = open(shared, unb64(fields[2]!), unb64(fields[3]!));
  if (opened.length <= KEY_BYTES) throw new ProtocolError("delivery did not carry a room name");
  return {
    roomKey: opened.subarray(0, KEY_BYTES),
    roomName: opened.subarray(KEY_BYTES).toString("utf8"),
  };
}

/** Encrypt one room line: `<nonce12_b64url>.<ct_b64url>`. */
export function encryptLine(roomKey: Buffer, plaintext: string): string {
  const { nonce, ciphertext } = seal(roomKey, Buffer.from(plaintext, "utf8"));
  return `${b64(nonce)}.${b64(ciphertext)}`;
}

export function decryptLine(roomKey: Buffer, line: string): string {
  const dot = line.indexOf(".");
  if (dot === -1) throw new ProtocolError("room line must be <nonce>.<ciphertext>");
  return open(roomKey, unb64(line.slice(0, dot)), unb64(line.slice(dot + 1))).toString("utf8");
}

export function generateRoomKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Persist a static X25519 key as an encrypted PKCS#8 PEM, owner-readable only. */
export function saveX25519(privateKey: KeyObject, path: string, passphrase: string): void {
  if (passphrase.length < 12) {
    throw new ProtocolError("passphrase must be at least 12 characters");
  }
  writeFileSync(
    path,
    privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

export function loadX25519(path: string, passphrase: string): KeyObject {
  const pem = readFileSync(path, "utf8");
  if (!pem.includes("BEGIN ENCRYPTED PRIVATE KEY")) {
    throw new ProtocolError(`refusing to load an unencrypted X25519 key: ${path}`);
  }
  return createPrivateKey({ key: pem, passphrase });
}

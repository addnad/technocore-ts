import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { didFromPublicKey, publicKeyFromDid } from "./did.js";
import { ProtocolError } from "./errors.js";

const SIGNATURE_BYTES = 64;
/** base64url of 64 bytes, unpadded */
export const SIGNATURE_LENGTH = 86;
const MIN_PASSPHRASE = 12;

/** DER prefix for a raw Ed25519 public key inside SubjectPublicKeyInfo. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class Identity {
  private constructor(
    readonly privateKey: KeyObject,
    readonly did: string,
  ) {}

  static generate(): Identity {
    const { privateKey } = generateKeyPairSync("ed25519");
    return Identity.fromPrivateKey(privateKey);
  }

  static fromPrivateKey(privateKey: KeyObject): Identity {
    const raw = createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .subarray(SPKI_PREFIX.length);
    return new Identity(privateKey, didFromPublicKey(new Uint8Array(raw)));
  }

  /** Load an encrypted PEM. Passphrase is required; unencrypted keys are refused. */
  static load(path: string, passphrase: string): Identity {
    const pem = readFileSync(path, "utf8");
    if (!pem.includes("BEGIN ENCRYPTED PRIVATE KEY")) {
      throw new ProtocolError(
        `refusing to load an unencrypted identity: ${path}`,
      );
    }
    return Identity.fromPrivateKey(createPrivateKey({ key: pem, passphrase }));
  }

  /** Write as an encrypted PKCS#8 PEM, owner-readable only. */
  save(path: string, passphrase: string): void {
    if (passphrase.length < MIN_PASSPHRASE) {
      throw new ProtocolError(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
    }
    const pem = this.privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase,
    });
    writeFileSync(path, pem, { mode: 0o600 });
    // chmod is a no-op on win32 — the POSIX bits are never honoured there, so
    // the file lands with default ACLs. The key is still encrypted, but it is
    // not permission-protected the way it is on POSIX. Skip the call rather
    // than pretending it did something.
    if (process.platform !== "win32") chmodSync(path, 0o600);
  }

  /** Sign bytes; returns 86 unpadded base64url characters. */
  sign(payload: Buffer): string {
    return edSign(null, payload, this.privateKey).toString("base64url");
  }
}

/** Verify a signature against the public key inside a did:key. Throws on failure. */
export function verifySignature(did: string, signature: string, payload: Buffer): void {
  if (signature.length !== SIGNATURE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    throw new ProtocolError(`signature must be ${SIGNATURE_LENGTH} base64url characters`);
  }
  const raw = Buffer.from(signature, "base64url");
  if (raw.length !== SIGNATURE_BYTES) {
    throw new ProtocolError(`signature must decode to ${SIGNATURE_BYTES} bytes`);
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyFromDid(did))]),
    format: "der",
    type: "spki",
  });
  if (!edVerify(null, payload, publicKey, raw)) {
    throw new ProtocolError("signature does not verify against the did");
  }
}

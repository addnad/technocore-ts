import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ProtocolError } from "./errors.js";

/**
 * Room keys are as sensitive as the identity key: anyone holding one can read
 * every message in that room. Stored encrypted under the same passphrase,
 * never in plaintext.
 */
export interface RoomEntry {
  room: string;
  key: string;
  peer?: string;
  created: string;
}

interface StoreShape {
  rooms: RoomEntry[];
  x25519?: string;
  mailbox?: string;
}

const MAGIC = "TCSTORE1";
const SCRYPT_N = 16384;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
}

export function loadStore(path: string, passphrase: string): StoreShape {
  if (!existsSync(path)) return { rooms: [] };
  const raw = readFileSync(path);
  if (raw.subarray(0, 8).toString() !== MAGIC) {
    throw new ProtocolError(`${path} is not a technocore store`);
  }
  const salt = raw.subarray(8, 24);
  const nonce = raw.subarray(24, 36);
  const tag = raw.subarray(36, 52);
  const body = raw.subarray(52);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), nonce);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as StoreShape;
  } catch {
    throw new ProtocolError("wrong passphrase for the room store");
  }
}

export function saveStore(path: string, passphrase: string, store: StoreShape): void {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(store), "utf8")),
    cipher.final(),
  ]);
  writeFileSync(
    path,
    Buffer.concat([Buffer.from(MAGIC), salt, nonce, cipher.getAuthTag(), body]),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

export function rememberRoom(store: StoreShape, entry: RoomEntry): StoreShape {
  const rooms = store.rooms.filter((r) => r.room !== entry.room);
  return { ...store, rooms: [...rooms, entry] };
}

export function findRoom(store: StoreShape, room: string): RoomEntry | undefined {
  return store.rooms.find((r) => r.room === room);
}

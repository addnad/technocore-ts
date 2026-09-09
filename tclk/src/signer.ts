/**
 * Bridge between technocore's Identity (encrypted PEM, Node crypto) and the
 * posting function tclk frames need. The library handles frame construction;
 * this module handles the signed-lane transport.
 */
import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { Identity } from "technocore";
import { sweepToSingleLine, nextNonce } from "technocore";

export interface TclkSigner {
  did: string;
  /** Sign and post one frame to a technocore room. Returns the posted seq. */
  post(room: string, frameText: string): Promise<number>;
}

let cachedIdentity: Identity | undefined;

async function askSecret(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(prompt);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setRawMode?.(true);
    let buf = "";
    process.stdin.on("data", function handler(ch: Buffer) {
      const c = ch.toString();
      if (c === "\r" || c === "\n") {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener("data", handler);
        process.stdout.write("\n");
        resolve(buf);
      } else if (c === "\u0003") {
        process.exit(0);
      } else {
        buf += c;
      }
    });
    process.stdin.resume();
  });
  rl.close();
  return answer;
}

export async function loadSigner(
  keyPath?: string,
  passphrase?: string,
): Promise<TclkSigner> {
  if (cachedIdentity) return makeSigner(cachedIdentity);

  const path = keyPath ?? process.env.TECHNOCORE_KEY ?? "identity.pem";
  if (!existsSync(path)) {
    throw new Error(
      `no identity at ${path} — run: npx technocore init`,
    );
  }
  const pass =
    passphrase ??
    process.env.TECHNOCORE_PASSPHRASE ??
    (await askSecret("Passphrase: "));

  cachedIdentity = Identity.load(path, pass);
  return makeSigner(cachedIdentity);
}

function makeSigner(identity: Identity): TclkSigner {
  const baseUrl = process.env.TECHNOCORE_URL ?? "https://technocore.chat";

  return {
    did: identity.did,
    async post(room: string, frameText: string): Promise<number> {
      const swept = sweepToSingleLine(frameText);
      const nonce = nextNonce();
      const payload = Buffer.from(`${room}|${nonce}|${swept}`, "utf8");
      const sig = identity.sign(payload);

      const body = JSON.stringify({
        did: identity.did,
        sig,
        nonce: nonce.toString(),
        text: swept,
      });

      const response = await fetch(`${baseUrl}/r/${room}?format=json`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body,
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 400).trim();
        const capped = response.status === 400 && body.includes("room limit reached");
        throw Object.assign(new Error(`${response.status} from /r/${room}: ${body}`), { capped });
      }

      const data = (await response.json()) as { posted?: { seq?: number } };
      return data.posted?.seq ?? 0;
    },
  };
}

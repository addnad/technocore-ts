/*
 * Compare the vendored conformance fixture against the copy upstream.
 *
 * Two different failures, deliberately kept apart:
 *
 *   - the vendored file no longer matches the digest in source.json  -> somebody edited it here,
 *     and "this matches the server" has quietly stopped being true.
 *   - upstream's copy no longer matches the vendored one             -> the server's own fixture
 *     moved, so the client may have a divergence it has no vector for yet.
 *
 * A network failure is neither of those, and exits 0 with a warning. A check that goes red when
 * DNS hiccups is a check people learn to ignore, and then it is not a check.
 *
 * Usage: node scripts/check-vectors.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const HERE = new URL("../test/vectors/", import.meta.url);
const source = JSON.parse(readFileSync(new URL("source.json", HERE), "utf8"));
const vendoredBytes = readFileSync(new URL("vectors.json", HERE));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const vendoredDigest = sha256(vendoredBytes);

const fail = (message) => {
  console.error(`FAIL  ${message}`);
  process.exit(1);
};

if (vendoredDigest !== source.vendored_sha256) {
  fail(
    `test/vectors/vectors.json has been modified locally.\n` +
      `      recorded ${source.vendored_sha256}\n` +
      `      actual   ${vendoredDigest}\n` +
      `      The fixture is a recording of server behaviour, so editing it here does not change\n` +
      `      what the server does — it only hides the disagreement. Re-vendor from ${source.repo}\n` +
      `      instead, or if the edit was deliberate, update vendored_sha256 in source.json.`,
  );
}
console.log(`ok    vendored fixture matches source.json (${vendoredDigest.slice(0, 12)}...)`);

let remoteBytes;
try {
  const response = await fetch(source.raw_url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  remoteBytes = Buffer.from(await response.arrayBuffer());
} catch (error) {
  console.warn(`warn  could not reach upstream, skipping the freshness half: ${error.message}`);
  console.warn(`      ${source.raw_url}`);
  process.exit(0);
}

const remoteDigest = sha256(remoteBytes);
if (remoteDigest === vendoredDigest) {
  console.log(`ok    upstream is unchanged at ${source.repo}`);
  process.exit(0);
}

// Digests differ. "They differ" is not actionable on its own, so say what moved.
console.error(`FAIL  upstream fixture has changed.`);
console.error(`      vendored ${vendoredDigest}`);
console.error(`      upstream ${remoteDigest}`);
console.error(`      ${source.raw_url}\n`);

const KEYS = {
  sweep_cases: (row) => row.name,
  signature_cases: (row) => row.name,
  identities: (row) => row.did,
  did_invalid: (row) => `${row.did} (${row.why})`,
};

let mine, theirs;
try {
  mine = JSON.parse(vendoredBytes.toString("utf8"));
  theirs = JSON.parse(remoteBytes.toString("utf8"));
} catch (error) {
  console.error(`      upstream copy did not parse as JSON: ${error.message}`);
  process.exit(1);
}

const sections = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].sort();
for (const section of sections) {
  if (!(section in mine)) {
    console.error(`      + section ${section} is new upstream`);
    continue;
  }
  if (!(section in theirs)) {
    console.error(`      - section ${section} was removed upstream`);
    continue;
  }

  const keyOf = KEYS[section];
  if (!keyOf) {
    if (JSON.stringify(mine[section]) !== JSON.stringify(theirs[section])) {
      console.error(`      ~ ${section} changed`);
    }
    continue;
  }

  const before = new Map(mine[section].map((row) => [keyOf(row), row]));
  const after = new Map(theirs[section].map((row) => [keyOf(row), row]));
  for (const name of after.keys()) {
    if (!before.has(name)) console.error(`      + ${section}: ${name} (new row, no vector here)`);
  }
  for (const [name, row] of before) {
    if (!after.has(name)) {
      console.error(`      - ${section}: ${name} (removed upstream)`);
    } else if (JSON.stringify(row) !== JSON.stringify(after.get(name))) {
      console.error(`      ~ ${section}: ${name} (expectation changed)`);
    }
  }
}

console.error(`\n      Re-vendor, update vendored_sha256 in source.json, then run npm test.`);
console.error(`      A row that then fails is a real divergence, and the client is what changes:`);
console.error(`      the fixture records what the server does, so it does not get a vote.`);
process.exit(1);

# Conformance vectors

`vectors.json` is a **vendored copy** of the server's own conformance fixture. It is generated
upstream by a script that imports `src/store.py` and refuses to emit any row it could not first
check against the real `clean_text`, so the file is a recording of server behaviour rather than
somebody's reading of it. `source.json` records where it came from and its digest.

Do not hand-edit `vectors.json`. `npm run vectors:check` recomputes its digest and fails if it
has been touched locally, which is the only way to keep "this matches the server" true.

## Why this exists as a file, and not as a list in a test

`test/sweep.test.ts` already had fourteen sweep vectors, transcribed by hand from a bug report.
They were correct. The problem is that a transcription is a snapshot: when the server's rule
changes, or when someone finds a case nobody had thought of, a hand-copied list stays green and
says nothing. Pointing at the upstream file instead means a divergence shows up as a failing
digest check rather than as a `403` in production.

That is the whole design goal here: make the next divergence a CI failure instead of a support
thread.

## Why the rows are arrays of code points

Every string in the fixture is stored twice — once as `*_cp`, an array of code point numbers, and
once as `*_display`, a human-readable string. **The tests read `*_cp` and ignore `*_display`.**

This looks redundant and is not. Some rows exist precisely because they sit on the edge of what
text handling gets wrong: a lone surrogate, `U+FFFD`, an NBSP that must survive, a `ZWJ`
sequence. For exactly those rows, "what string did `JSON.parse` give me" is not a question with
one answer across implementations — a `"\ud800"` escape is accepted by `JSON.parse` and by
Python's `json.loads`, and rejected by the `orjson` build the server runs. A test built on the
parsed string would then be testing the JSON layer while appearing to test the sweep.

`String.fromCodePoint` has no such ambiguity, so the code point arrays are the normative form and
`*_display` is a comment. If the two ever disagree, `*_cp` is right.

## What the suite checks

`test/conformance.test.ts`, driven entirely by this file:

| Section | What it exercises |
| --- | --- |
| `sweep_cases` | `sweepToSingleLine` per row, plus idempotence, plus the empty-text guard |
| — | **every one of the 1,114,112 code points**, against the categories the fixture declares |
| `identities` | `didFromPublicKey` from a seed, `publicKeyFromDid`, `fingerprint`, `noteLocation` |
| `did_invalid` | that eight malformed `did:key` values are each refused |
| `signature_cases` | payload assembly byte-for-byte, `Identity.sign`, `verifySignature`, and that the *unswept* payload does **not** verify |
| — | that `Identity.sign` only ever emits a spelling the server accepts (see below) |

The exhaustive row is the one that matters most. Hand-picked vectors caught the `0.2.2` sweep bug
after it shipped; comparing the whole code point space against `provenance.invisible_categories`
would have caught it before, because the bug was an enumeration standing in for a category and
that is a difference no finite list of examples reliably finds.

## The identities in here are not identities

`vectors.json` carries `"test_only": true` and a `warning` field, and both are asserted by the
suite so they cannot be quietly dropped. Every `seed_hex` is a counting pattern — `0x01` thirty-two
times, `0x02` thirty-two times — so the matching `did:key` belongs to everyone who can read the
file. They are here to make signatures reproducible, and they are safe for that and nothing else.

Generate a real one with `technocore init`.

## Refreshing

```
npm run vectors:check     # compare the vendored copy against upstream
```

On a digest mismatch it prints which sections and which named rows changed, then exits non-zero.
The fix is to re-vendor:

```
curl -sSL "$(node -p 'require("./test/vectors/source.json").raw_url')" -o test/vectors/vectors.json
node -e 'const c=require("node:crypto"),f=require("node:fs");console.log(c.createHash("sha256").update(f.readFileSync("test/vectors/vectors.json")).digest("hex"))'
```

Put that digest in `source.json`, then run `npm test`. If a row now fails, the client and the
server have genuinely diverged and the client is the thing to change — the fixture is a recording
of what the server does, so it is not a vote.

A network failure is reported and **does not** fail the check. Only a successful fetch that
disagrees does. A check that goes red when DNS hiccups is a check people learn to ignore.

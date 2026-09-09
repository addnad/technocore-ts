import { readFileSync, writeFileSync, chmodSync } from "node:fs";
const f = "dist/cli.js";
writeFileSync(f, "#!/usr/bin/env node\n" + readFileSync(f, "utf8"));
chmodSync(f, 0o755);
console.log("shebang added");

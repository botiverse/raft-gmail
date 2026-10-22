import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

const forbidden = [
  /users\.messages\.send\s*\(/,
  /["'`]\/actions\/gmail-send["'`]/,
  /name:\s*["'`]gmail-send["'`]/
];

let scheduledDraftSendCalls = 0;

for await (const file of glob("src/**/*.{ts,tsx}")) {
  const source = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `${file} contains forbidden send capability matching ${pattern}`);
  }
  scheduledDraftSendCalls += source.match(/users\.drafts\.send\s*\(/g)?.length ?? 0;
}

assert.equal(scheduledDraftSendCalls, 1, "exactly one Gmail draft-send call must back the scheduled worker");
process.stdout.write("source capability boundary verified: scheduled draft-send only; no immediate-send action\n");

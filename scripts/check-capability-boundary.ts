import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";

const forbidden = [
  /users\.messages\.send\s*\(/,
  /users\.drafts\.send\s*\(/,
  /["'`]\/actions\/gmail-send["'`]/,
  /name:\s*["'`]gmail-send["'`]/
];

for await (const file of glob("src/**/*.ts")) {
  const source = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `${file} contains forbidden send capability matching ${pattern}`);
  }
}

process.stdout.write("source capability boundary verified: no Gmail send action or call\n");

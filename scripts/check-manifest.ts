import assert from "node:assert/strict";
import { buildManifest } from "../src/manifest.js";

const manifest = buildManifest("https://example.test");
const actionNames = manifest.actions.map((action) => action.name);

assert.deepEqual(actionNames, ["gmail-access-request", "gmail-search", "gmail-read", "gmail-draft-create", "gmail-draft-update"]);
assert.equal(actionNames.some((name) => /send|schedule|delete|archive|mark.?read/i.test(name)), false);
assert.equal(JSON.stringify(manifest).includes("gmail.send"), true);
process.stdout.write("manifest capability boundary verified\n");

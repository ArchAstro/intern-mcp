import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const [, , command, platformArgument] = process.argv;
if (command !== "check" && command !== "sync") {
  throw new Error("usage: npm run check:runtime-contract -- <firstlanding-path>");
}
if (!platformArgument) {
  throw new Error("the Firstlanding checkout path is required");
}

const platform = path.resolve(platformArgument);
const source = path.join(
  platform,
  "services/go/intern-data/internal/sites/runtime-contract.json",
);
const fixture = path.resolve("test/fixtures/runtime-contract.json");

if (command === "sync") {
  await fs.copyFile(source, fixture);
  process.stdout.write(`Synchronized ${fixture} from ${source}.\n`);
} else {
  const [expected, actual] = await Promise.all([
    fs.readFile(source, "utf8"),
    fs.readFile(fixture, "utf8"),
  ]);
  assert.equal(
    actual,
    expected,
    `runtime fixture drifted; run node scripts/runtime-contract.mjs sync ${platform}`,
  );
  process.stdout.write("Runtime contract fixture matches Firstlanding.\n");
}

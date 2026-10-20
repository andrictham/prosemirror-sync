import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";

const root = process.cwd();
const scratch = mkdtempSync(path.join(tmpdir(), "prosemirror-sync-package-"));
const packed = JSON.parse(
  execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
    { encoding: "utf8" },
  ),
)[0];
execFileSync("tar", [
  "-xzf",
  path.join(scratch, packed.filename),
  "-C",
  scratch,
]);
const packageRoot = path.join(scratch, "package");
symlinkSync(
  path.join(root, "node_modules"),
  path.join(packageRoot, "node_modules"),
  "dir",
);
const manifest = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);
for (const [name, target] of Object.entries(manifest.exports)) {
  const targets = typeof target === "string" ? [target] : Object.values(target);
  for (const file of targets)
    assert(
      existsSync(path.join(packageRoot, file)),
      `${name}: missing ${file}`,
    );
  const runtime = typeof target === "string" ? target : target.default;
  if (runtime && runtime.endsWith(".js"))
    await import(pathToFileURL(path.join(packageRoot, runtime)).href);
}
// The public test entrypoint deliberately uses Vite's import.meta.glob API.
const server = await createServer({
  configFile: false,
  envFile: false,
  root: packageRoot,
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const testing = await server.ssrLoadModule("/src/test.ts");
  assert.equal(typeof testing.register, "function");
} finally {
  await server.close();
}
console.info(
  "Packed source, declarations, runtime exports, and Vite test export passed.",
);

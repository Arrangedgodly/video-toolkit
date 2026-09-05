import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// T27 drift lock over the npm packaging manifest — pure JSON assertions, no
// network, no npm invocation: the empirical pack/tarball/prefix proof lives in
// production-log.md (T27 WORKER entry); this keeps the manifest from drifting
// away from what that proof certified. Runs from dist/test/, so the manifest
// is exactly two levels up.
const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  files?: string[];
  scripts?: Record<string, string>;
  bin?: Record<string, string>;
  engines?: { node?: string };
};

test("files allowlist ships the package surface (dist, src, contract docs)", () => {
  // superset lock — T28's `examples` amendment extends, never narrows
  const required = ["dist", "src", "AGENTS.md", "README.md", "LICENSE"];
  for (const entry of required) {
    assert.ok(pkg.files?.includes(entry), `files must include "${entry}"`);
  }
  // the tarball exclusions T27's acceptance verifies by listing: repo-internal
  // paths must never leak into the allowlist
  const forbidden = [".video-agent", "demo", "docs", ".github", "node_modules", "tsconfig.json"];
  for (const entry of forbidden) {
    assert.ok(!pkg.files?.includes(entry), `files must NOT include "${entry}"`);
  }
});

test("prepare builds at install time and reuses the existing build script", () => {
  // npm runs prepare on git-dependency installs and before `npm pack` — the
  // git-install path compiles dist/ itself
  assert.equal(pkg.scripts?.prepare, "npm run build");
  assert.ok(typeof pkg.scripts?.build === "string" && pkg.scripts.build.length > 0);
});

test("build chmods BOTH bin entries (the tarball carries mode-0755 bins)", () => {
  const build = pkg.scripts?.build ?? "";
  assert.ok(build.includes("chmod +x"), "build must chmod the bin outputs");
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    assert.ok(build.includes(target), `build must chmod the "${name}" bin (${target})`);
  }
});

test("both documented bins present, each pointing under dist/", () => {
  const bin = pkg.bin ?? {};
  for (const name of ["video", "video-mcp"]) {
    assert.ok(name in bin, `bin must declare "${name}"`);
  }
  for (const [name, target] of Object.entries(bin)) {
    assert.ok(
      target.startsWith("dist/"),
      `bin "${name}" must live under dist/ (got ${target}) — src is shipped for reading, never executed`,
    );
  }
});

test("engines.node stays >= 20 (the documented prerequisite)", () => {
  const match = /^>=(\d+)$/.exec(pkg.engines?.node ?? "");
  assert.ok(match, `engines.node must be a ">=N" range (got ${pkg.engines?.node})`);
  assert.ok(Number(match[1]) >= 20, "engines.node floor must be at least 20");
});

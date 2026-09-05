import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { overlayFontAvailable } from "./font-availability.js";
import { OVERLAY_FONT_FILE } from "../media/ffmpeg.js";

test("overlayFontAvailable: true for a present file, false for an absent one", async () => {
  // both branches deterministic on EVERY machine: a path that always exists
  // (this node binary) and one that never can
  assert.equal(await overlayFontAvailable(process.execPath), true);
  assert.equal(await overlayFontAvailable("/nonexistent/no-such-font.ttc"), false);
  // the real gate, branch-honest everywhere: the default-arg predicate
  // agrees with the filesystem wherever it runs (darwin dev boxes true,
  // font-less linux CI false — the skip flags consume exactly this)
  assert.equal(await overlayFontAvailable(), existsSync(OVERLAY_FONT_FILE));
});

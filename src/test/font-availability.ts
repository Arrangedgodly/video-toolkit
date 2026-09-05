import { stat } from "node:fs/promises";
import { OVERLAY_FONT_FILE } from "../media/ffmpeg.js";

/** Test-only availability probe for the overlay-text fixed font — the
 * transcribe-integration engine-guard precedent applied to the font. True
 * iff `file` stats. Callers evaluate it at MODULE LOAD (top-level await) so
 * node:test registration-time `skip` flags see it — the same discipline as
 * `handyAvailable`/`whisperAvailable` in transcribe-integration.test.ts.
 *
 * The ENGINE behavior is unchanged and deliberately stricter: validate stats
 * the same path and rejects the plan with `OPERATION_INVALID` naming the font
 * (correct-by-error for real users on font-less machines). This predicate
 * exists only so the font-DEPENDENT integration tests SKIP (never fail) on
 * such machines; the pure builder/escaping units in ops.test.ts are string
 * checks and keep running everywhere. */
export async function overlayFontAvailable(file: string = OVERLAY_FONT_FILE): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

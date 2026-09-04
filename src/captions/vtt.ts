import type { Cue } from "./srt.js";
import { formatSrtTime } from "./srt.js";

/** WebVTT output variant of the SRT formatters: identical cue model and cue
 * math (srt.ts is untouched), WebVTT syntax — `WEBVTT` header, `.`-separated
 * milliseconds, HTML-escaped cue text. */

export function formatVttTime(t: number): string {
  // derive from the SRT formatter so rounding/padding can never drift:
  // the only difference is the millisecond separator (`,` → `.`)
  return formatSrtTime(t).replace(",", ".");
}

/** WebVTT cue text is HTML-ish markup; raw `&`, `<`, `>` would open entities
 * or tags. SRT stays raw (no behavior change there). */
export function escapeVttText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatVtt(cues: Cue[]): string {
  const body = cues
    .map((c, i) => {
      const text = escapeVttText(c.text.replace(/\s*[\r\n]+\s*/g, " ").trim());
      return `${i + 1}\n${formatVttTime(c.start)} --> ${formatVttTime(c.end)}\n${text}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

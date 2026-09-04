/** Canonical error codes. Every predictable failure maps to one of these so
 * agents can branch on `code` instead of parsing prose. */
export type ErrorCode =
  | "PLAN_INVALID_JSON"
  | "PLAN_SCHEMA_INVALID"
  | "SOURCE_NOT_FOUND"
  | "TIMESTAMP_OUT_OF_RANGE"
  | "RANGE_NEGATIVE"
  | "EMPTY_TIMELINE"
  | "OUTPUT_PATH_INVALID"
  | "OUTPUT_EXISTS"
  | "OUTPUT_WOULD_OVERWRITE_SOURCE"
  | "FFMPEG_NOT_FOUND"
  | "FFPROBE_NOT_FOUND"
  | "FFMPEG_FAILED"
  | "UNSUPPORTED_MEDIA"
  | "OBSERVATION_INVALID"
  | "OPERATION_INVALID"
  | "TRANSCRIPTION_ENGINE_UNAVAILABLE"
  | "TRANSCRIPTION_ENGINE_FAILED";

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: string; message: string; details?: Record<string, unknown> } {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new ToolError(code, message, details);
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  handleMessage,
  KNOWN_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
  type McpMessage,
} from "./mcp-server.js";

/**
 * MCP streamable-HTTP adapter (spec revisions 2025-06-18/2025-11-25 — the
 * initialize era every deployed client speaks; 2026-era clients fall back to
 * initialize on our 400, per the spec's Backward Compatibility section).
 * Minimal contract from docs/ultron/research/r4-mcp-streamable-http.md plus
 * the R6 progress extension (docs/ultron/research/r6-mcp-progress-sse.md):
 * ONE node:http server, a single /mcp path, plain-JSON replies — EXCEPT a
 * `tools/call` carrying `_meta.progressToken`, which opts into an SSE reply
 * streaming `notifications/progress` and closing with the final response
 * frame (byte-identical to the plain path). This server still never pushes
 * unsolicited: no GET stream, no keep-alive channel. Sessions issued at
 * initialize but never required. Same dispatcher as the stdio transport
 * (handleMessage); no tool logic here.
 */

export interface HttpServeOptions {
  /** default 8765; 0 = OS-assigned free port (chosen URL printed to stderr) */
  port?: number;
  /** default 127.0.0.1 (spec SHOULD: bind localhost when running locally) */
  host?: string;
  /** bearer token; the CLI enforces "mandatory when --host is non-loopback" */
  token?: string;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** DNS-rebinding defense (spec MUST: validate Origin; localhost tooling only —
 * non-loopback exposure is gated by the mandatory token instead). */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// ---- R6 progress-over-SSE (docs/ultron/research/r6-mcp-progress-sse.md) ----
// T30: this block (conformance predicate + sink factory + throttle constants)
// is the ONE home of progress policy — the stdio transport imports the same
// exports (isLoopbackHost precedent), so framing differs but the gate never
// drifts between transports.

/** Throttle item 5 (committed): emit only when ≥250 ms AND ≥1.0 progress-point
 * have passed — bounds both rate (≤4/s) and total count (≤100 events per
 * render: each must advance ≥1 point of a 0–100 domain, regardless of length). */
export const PROGRESS_MIN_INTERVAL_MS = 250;
export const PROGRESS_MIN_DELTA = 1.0;

/** R6 checklist item 1: a `tools/call` opts into progress IFF its
 * `params._meta.progressToken` is a string or an integer — float/object/
 * null/absent are treated as absent (⇒ the plain path). Exported because the
 * stdio transport applies the IDENTICAL rule to the same message shape (T30);
 * single source of truth, no per-transport drift. */
export function conformingProgressToken(message: McpMessage): string | number | undefined {
  if (message.method !== "tools/call") return undefined;
  const meta = message.params?._meta;
  const rawToken =
    typeof meta === "object" && meta !== null && !Array.isArray(meta)
      ? (meta as Record<string, unknown>).progressToken
      : undefined;
  if (typeof rawToken === "string" || (typeof rawToken === "number" && Number.isInteger(rawToken))) {
    return rawToken;
  }
  return undefined;
}

/**
 * Throttled, strictly-increasing progress sink for one streamed request (R6
 * checklist items 4–5). Receives RAW engine events (percent may be null,
 * regress, or jump — the ffmpeg parse is not monotonic) and emits a
 * `notifications/progress` object only when BOTH gates pass:
 * `now - lastEmitMs >= 250` AND `percent - lastSent >= 1.0`. `lastSent`
 * updates only on emission, so the emitted `progress` sequence is strictly
 * increasing; `percent === null` is skipped (no total known at the engine
 * level). The token is echoed VERBATIM — string stays a string, integer stays
 * a number (the SDK keys its handlers on the raw value). No synthetic final
 * 100% event: the response frame IS completion ("MUST stop after completion").
 * `now` is injectable so tests drive the throttle with a fake clock — no real
 * sleeps. Stateless per request; dead once the transport stops writing.
 */
export function createProgressSink(
  token: string | number,
  write: (obj: unknown) => void,
  now: () => number = Date.now,
): (p: { percent: number | null; timeSec: number; message?: string }) => void {
  let lastEmitMs = -Infinity; // first eligible event emits immediately
  let lastSent = 0; // the 0–100 domain starts at 0
  return (p) => {
    if (p.percent === null || !Number.isFinite(p.percent)) return;
    const nowMs = now();
    if (nowMs - lastEmitMs < PROGRESS_MIN_INTERVAL_MS) return;
    if (p.percent - lastSent < PROGRESS_MIN_DELTA) return;
    lastEmitMs = nowMs;
    lastSent = p.percent;
    write({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: p.percent,
        total: 100,
        // (T26) batch events carry their own formatted message naming the
        // in-flight plan; render/preview keep the historical time message
        message: p.message ?? `rendering ${p.timeSec.toFixed(1)}s`,
      },
    });
  };
}

/**
 * The SSE reply for one token-carrying `tools/call` (R6 checklist items 2–7).
 * Runs after EVERY R4 gate has passed (a streamed call has passed every gate a
 * plain call would). Head goes out BEFORE the tool runs (do not hold headers
 * while ffmpeg spawns); every frame is `event: message\ndata: <one JSON-RPC
 * object>\n\n`; the final frame is the exact object handleMessage returns —
 * byte-identical to the plain path's body (same JSON.stringify, same
 * isError-as-result semantics) — then `end()`. Exactly one response frame per
 * stream, always, including every error path. All writes are guarded: a client
 * disconnect mid-render stops emitting while the render FINISHES and the
 * response is discarded — disconnect is NOT cancellation in the initialize era
 * (neither is DELETE; `notifications/cancelled` rides the 202 branch, ignored).
 */
async function replySseCall(
  message: McpMessage,
  res: ServerResponse,
  progressToken: string | number,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // 2026-era SHOULD; one line, forward-compat
    // NO Content-Length — the reply is chunked and self-delimiting
  });
  res.flushHeaders();
  const alive = (): boolean => !res.destroyed && !res.writableEnded;
  const writeFrame = (obj: unknown): void => {
    if (!alive()) return;
    try {
      res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
    } catch {
      // client vanished mid-stream — swallow; the render keeps running
    }
  };
  const onProgress = createProgressSink(progressToken, writeFrame);
  let out: JsonRpcResponse | null;
  try {
    out = await handleMessage(message, { negotiateProtocolVersion: true, onProgress });
  } catch (e) {
    // item 6: never close without a response — the SDK would hang its
    // pending promise until timeout
    out = {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32603,
        message: `internal error: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  if (out !== null) writeFrame(out);
  if (alive()) {
    try {
      res.end(); // close AFTER the response frame, never before
    } catch {
      // already gone — nothing to close
    }
  }
}

export function startHttpServer(opts: HttpServeOptions = {}): Server {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8765;
  const token = opts.token;
  const sessions = new Set<string>();

  const jsonError = (
    res: ServerResponse,
    status: number,
    code: number,
    message: string,
    extraHeaders: Record<string, string> = {},
  ): void => {
    // JSON-RPC error body WITHOUT id — the 2025-11-25 transport-error shape.
    const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message } });
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...extraHeaders,
    });
    res.end(body);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. routing: one endpoint path, query string stripped
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://x").pathname;
    } catch {
      pathname = "/";
    }
    if (pathname !== "/mcp") {
      jsonError(res, 404, -32600, `unknown path: ${pathname}`);
      return;
    }
    // 2. GET/HEAD → 405 (spec-allowed: no push channel — this server never streams)
    if (req.method === "GET" || req.method === "HEAD") {
      res.writeHead(405, { Allow: "POST", "Content-Length": 0 });
      res.end();
      return;
    }
    // 3. DELETE → 204, drop the presented session (clients SHOULD send it; we
    //    honor termination rather than 405 — cheaper and friendlier)
    if (req.method === "DELETE") {
      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") sessions.delete(sid);
      res.writeHead(204, { "Content-Length": 0 });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Length": 0 });
      res.end();
      return;
    }
    // 4. origin gate — before session/version checks, before body parse
    const origin = req.headers.origin;
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) {
      jsonError(res, 403, -32600, `invalid origin: ${origin}`);
      return;
    }
    // 5. auth gate
    if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) {
      jsonError(res, 401, -32600, "missing or invalid bearer token", { "WWW-Authenticate": "Bearer" });
      return;
    }
    // 6. session validity — issued, never required; a dead id is the resync
    //    signal (clients drop it and re-initialize)
    const sessionHeader = req.headers["mcp-session-id"];
    if (typeof sessionHeader === "string" && !sessions.has(sessionHeader)) {
      jsonError(res, 404, -32600, "session not found — re-initialize without the session header");
      return;
    }
    // 7. protocol-version header — absent means 2025-03-26 semantics (identical
    //    for our surface); unknown values 400 with a NON-modern error body,
    //    which is also the 2026-era client fallback trigger
    const versionHeader = req.headers["mcp-protocol-version"];
    if (typeof versionHeader === "string" && !KNOWN_PROTOCOL_VERSIONS.has(versionHeader)) {
      jsonError(res, 400, -32600, `unsupported MCP-Protocol-Version: ${versionHeader}`);
      return;
    }
    // 8. body — cap then parse
    const declared = req.headers["content-length"];
    if (typeof declared === "string" && Number(declared) > MAX_BODY_BYTES) {
      req.resume(); // drain, keep the connection coherent
      jsonError(res, 413, -32600, "request body too large");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        jsonError(res, 413, -32600, "request body too large");
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      jsonError(res, 400, -32700, "request body is not valid JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      jsonError(res, 400, -32600, "request body is not a JSON-RPC message");
      return;
    }
    const message = parsed as McpMessage & { result?: unknown; error?: unknown };
    // 9. dispatch — notifications (no id / null id) and client responses → 202;
    //    requests → 200 + exactly one JSON-RPC object (plain JSON, or an SSE
    //    stream for the token-carrying tools/call branch right below).
    //    JSON-RPC-level errors (unknown method, tool failures as isError
    //    results) ride in 200 bodies — HTTP 4xx stays reserved for
    //    transport-level failures.
    const isNotification = message.id === undefined || message.id === null;
    const isResponse =
      message.method === undefined && (message.result !== undefined || message.error !== undefined);
    if (isNotification || isResponse) {
      res.writeHead(202, { "Content-Length": 0 });
      res.end();
      return;
    }
    // 9b. R6: a `tools/call` carrying a CONFORMING `_meta.progressToken`
    //     (conformingProgressToken — string or integer; float/object/null/
    //     absent are treated as absent ⇒ plain path) opts into the SSE reply.
    //     Placement: AFTER every R4 gate above (security is complete before
    //     any stream opens — a streamed call has passed every gate a plain
    //     call would), BEFORE handleMessage is awaited. No tool-name allowlist
    //     (the committed rule): every token-carrying call streams; tools
    //     without progress wiring (inspect, validate, …) simply emit a
    //     response-only stream.
    if (message.method === "tools/call") {
      const progressToken = conformingProgressToken(message);
      if (progressToken !== undefined) {
        await replySseCall(message, res, progressToken);
        return;
      }
    }
    const out = await handleMessage(message, { negotiateProtocolVersion: true });
    if (out === null) {
      res.writeHead(202, { "Content-Length": 0 });
      res.end();
      return;
    }
    const headers: Record<string, string | number> = { "Content-Type": "application/json" };
    // 10. session id issued at initialization — crypto-secure, added to the
    //     live set; the header is optional for clients
    if (message.method === "initialize") {
      const sid = randomUUID();
      sessions.add(sid);
      headers["Mcp-Session-Id"] = sid;
    }
    // 11. explicit Content-Length — unambiguous keep-alive framing, no chunked
    const body = JSON.stringify(out);
    headers["Content-Length"] = Buffer.byteLength(body);
    res.writeHead(200, headers);
    res.end(body);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) {
        jsonError(res, 500, -32600, `transport error: ${e instanceof Error ? e.message : String(e)}`);
      } else {
        res.destroy();
      }
    });
  });

  // 12. listen; announce the URL on stderr (stdout stays clean — stdio mode's
  //     stdout IS the protocol; same discipline here)
  server.listen(port, host);
  server.on("listening", () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
    const shown = host.includes(":") ? `[${host}]` : host;
    process.stderr.write(`mcp-serve listening: http://${shown}:${actualPort}/mcp\n`);
  });
  return server;
}

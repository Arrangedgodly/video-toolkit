import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { handleMessage, KNOWN_PROTOCOL_VERSIONS, type McpMessage } from "./mcp-server.js";

/**
 * MCP streamable-HTTP adapter (spec revisions 2025-06-18/2025-11-25 — the
 * initialize era every deployed client speaks; 2026-era clients fall back to
 * initialize on our 400, per the spec's Backward Compatibility section).
 * Minimal contract from docs/ultron/research/r4-mcp-streamable-http.md:
 * ONE node:http server, a single /mcp path, plain-JSON replies (no SSE — this
 * server never pushes), sessions issued at initialize but never required.
 * Same dispatcher as the stdio transport (handleMessage); no tool logic here.
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
    //    requests → 200 + exactly one JSON-RPC object. JSON-RPC-level errors
    //    (unknown method, tool failures as isError results) ride in 200 bodies
    //    — HTTP 4xx stays reserved for transport-level failures.
    const isNotification = message.id === undefined || message.id === null;
    const isResponse =
      message.method === undefined && (message.result !== undefined || message.error !== undefined);
    if (isNotification || isResponse) {
      res.writeHead(202, { "Content-Length": 0 });
      res.end();
      return;
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

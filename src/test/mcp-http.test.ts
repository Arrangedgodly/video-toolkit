import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { runCapture } from "../media/ffprobe.js";
import { createProgressSink, isLoopbackHost } from "../agent/mcp-http.js";

// T16 — MCP streamable-HTTP transport. Raw fetch (no HTTP client deps) against
// a spawned `video mcp-serve` on an OS-assigned port, plus stdio byte-identity
// regressions for the refactored dispatcher and the off-loopback token fence.
// T20 — progress-over-SSE (R6's committed checklist): throttled strictly-
// increasing notifications/progress on token-carrying tools/call, closed by
// the plain-path-identical final response frame; every other shape unchanged.
// T23 — batch progress over the same sink: a token-carrying
// video_render_batch on a real multi-plan batch streams the AGGREGATED
// overall ((Σ per-plan fractions)/N × 100) and closes with the unchanged
// BatchReport; no-token/stdio stay on their byte-identical paths.

const FIXTURE = "fixture.mp4"; // 8s, audio + video
/** T20 SSE fixtures: 20 s 720p — a final render runs ≥ ~2 s wall here, long
 * enough for several ffmpeg progress chunks (stats every ~0.5 s) to clear the
 * 250 ms / 1.0-point dual gate, so ≥2 notifications are guaranteed, not racy. */
const SSE_FIXTURE = "sse-src.mp4";
const SSE_PLAN = "sse-plan.json"; // final render → sse-out.mp4 (+ .preview.mp4)
const SSE_PLAN_B = "sse-plan-b.json"; // disconnect probe needs its own output
const CLI = path.resolve(import.meta.dirname, "..", "cli", "index.js");
const SERVER = path.resolve(import.meta.dirname, "..", "agent", "mcp-server.js");

const TOOLS = [
  "video_benchmark", "video_captions", "video_detect_filler", "video_detect_scenes",
  "video_detect_silence", "video_diagnose", "video_doctor", "video_extract_frames",
  "video_find_highlights", "video_generate_proxy", "video_inspect", "video_measure_loudness",
  "video_plan", "video_plan_lint", "video_preview", "video_render", "video_render_batch",
  "video_review_frames", "video_transcribe", "video_transitions", "video_validate",
];

let dir = "";
let serve: ChildProcess | null = null; // no token (loopback default)
let serveBase = "";
let serveStdout = "";
let tokenServe: ChildProcess | null = null; // --token sekrit
let tokenBase = "";
let nextId = 0;

interface ServeHandle {
  proc: ChildProcess;
  base: string;
}

function startServe(args: string[]): Promise<ServeHandle> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI, "mcp-serve", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const fail = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`mcp-serve did not announce listening; stderr so far: ${stderr}`));
    }, 20000);
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (d: string) => {
      stderr += d;
      const m = stderr.match(/listening: http:\/\/([^:\s]+):(\d+)\/mcp/);
      if (m && !settled) {
        settled = true;
        clearTimeout(fail);
        resolve({ proc, base: `http://${m[1]}:${m[2]}` });
      }
    });
    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(fail);
        reject(new Error(`mcp-serve exited before listening (code ${code}); stderr: ${stderr}`));
      }
    });
    proc.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(fail);
        reject(e);
      }
    });
  });
}

function rpc(method: string, params?: Record<string, unknown>, notify = false): string {
  const id = ++nextId;
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!notify) msg.id = id;
  if (params) msg.params = params;
  return JSON.stringify(msg);
}

function post(base: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

/** Spawn the stdio server, write lines, and resolve the collected response
 * LINES (verbatim bytes) once `expect` lines have arrived (plus a short grace
 * window so unexpected stragglers are caught) or at the overall timeout —
 * no-response cases then resolve with fewer lines and fail their exact-bytes
 * assertion. Robust under full-suite CPU contention: we always WAIT for the
 * expected output instead of racing a fixed quiet timer. */
function stdioExchange(lines: string[], expect: number, graceMs = 350, timeoutMs = 10000): Promise<string[]> {
  const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
  const out: string[] = [];
  let pending = "";
  return new Promise((resolve) => {
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (grace !== undefined) clearTimeout(grace);
      clearTimeout(overall);
      proc.kill();
      resolve(out);
    };
    const overall = setTimeout(finish, timeoutMs);
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: string) => {
      if (settled) return;
      pending += d;
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        out.push(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
      if (out.length >= expect) {
        if (grace !== undefined) clearTimeout(grace);
        grace = setTimeout(finish, graceMs);
      }
    });
    proc.stdin!.on("error", () => {
      // EPIPE after kill — expected
    });
    for (const line of lines) proc.stdin!.write(line + "\n");
  });
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-mcp-http-"));
  process.chdir(dir);
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "8", "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", FIXTURE,
  ]);
  assert.equal(r.code, 0, r.stderr);

  const sr = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "20", "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", SSE_FIXTURE,
  ]);
  assert.equal(sr.code, 0, sr.stderr);
  const plan = (out: string): string =>
    JSON.stringify({
      version: 1,
      source: SSE_FIXTURE,
      operations: [{ type: "trim", start: 0, end: 20 }],
      output: { path: out, mode: "final" },
    });
  await writeFile(SSE_PLAN, plan("sse-out.mp4"));
  await writeFile(SSE_PLAN_B, plan("sse-out-b.mp4"));

  // T23 SSE batch fixtures: 3 whole-source PREVIEW plans off the 20 s source
  // (previews are real renders with progress parses, cheap at 640 w) — a
  // multi-plan batch whose aggregate spans the throttle gates.
  const batchPlan = (out: string): string =>
    JSON.stringify({
      version: 1,
      source: SSE_FIXTURE,
      operations: [{ type: "trim", start: 0, end: 20 }],
      output: { path: out, mode: "preview" },
    });
  for (const [name, out] of [
    ["batch-a.json", "batch-a.mp4"],
    ["batch-b.json", "batch-b.mp4"],
    ["batch-c.json", "batch-c.mp4"],
  ] as const) {
    await writeFile(name, batchPlan(out));
  }

  const main = await startServe(["--port", "0"]); // OS-assigned ephemeral port
  serve = main.proc;
  serveBase = main.base;
  serve.stdout!.setEncoding("utf8");
  serve.stdout!.on("data", (d: string) => {
    serveStdout += d; // must stay empty: stdout is protocol-only
  });

  const withToken = await startServe(["--port", "0", "--token", "sekrit"]);
  tokenServe = withToken.proc;
  tokenBase = withToken.base;
});

after(async () => {
  serve?.kill();
  tokenServe?.kill();
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

test("HTTP: initialize → 200 application/json + Mcp-Session-Id (UUID), version echoed", async () => {
  const res = await post(serveBase, rpc("initialize", { protocolVersion: "2025-06-18" }));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")!.startsWith("application/json"));
  const sid = res.headers.get("mcp-session-id");
  assert.ok(sid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sid), `session id not a UUID: ${sid}`);
  const body = await jsonBody(res);
  const result = body.result as { protocolVersion: string; serverInfo: { name: string } };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.equal(result.serverInfo.name, "video-toolkit");
});

test("HTTP: initialize with unknown body version answers 2025-06-18 (negotiation)", async () => {
  const res = await post(serveBase, rpc("initialize", { protocolVersion: "2024-05-01" }));
  assert.equal(res.status, 200);
  const result = (await jsonBody(res)).result as { protocolVersion: string };
  assert.equal(result.protocolVersion, "2025-06-18");
});

test("HTTP: full client flow — initialize → notification 202 → tools/list → tools/call inspect", async () => {
  const init = await post(serveBase, rpc("initialize", { protocolVersion: "2025-06-18" }));
  const session = init.headers.get("mcp-session-id")!;
  assert.ok(session);

  const headers = { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18" };

  const notified = await post(serveBase, rpc("notifications/initialized", undefined, true), headers);
  assert.equal(notified.status, 202);
  assert.equal(await notified.text(), "");

  const listed = await post(serveBase, rpc("tools/list"), headers);
  assert.equal(listed.status, 200);
  const tools = ((await jsonBody(listed)).result as { tools: { name: string }[] }).tools
    .map((t) => t.name)
    .sort();
  assert.deepEqual(tools, TOOLS); // registry parity with the stdio transport

  const called = await post(
    serveBase,
    rpc("tools/call", { name: "video_inspect", arguments: { input: FIXTURE } }),
    headers,
  );
  assert.equal(called.status, 200);
  const call = (await jsonBody(called)).result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(call.isError, true);
  const data = JSON.parse(call.content[0]!.text) as { duration: number; video?: object };
  assert.ok(Math.abs(data.duration - 8) < 0.2);
  assert.ok(data.video);
});

test("HTTP: stateless client (no session header ever) is accepted", async () => {
  const res = await post(serveBase, rpc("tools/list"));
  assert.equal(res.status, 200);
  const tools = ((await jsonBody(res)).result as { tools: unknown[] }).tools;
  assert.equal(tools.length, TOOLS.length);
});

test("HTTP: JSON-RPC-level errors ride in 200 bodies — unknown method is -32601", async () => {
  const res = await post(serveBase, rpc("resources/list"));
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.equal((body.error as { code: number }).code, -32601);
});

test("HTTP: tool failure is a 200 isError result with the machine-readable code", async () => {
  const res = await post(serveBase, rpc("tools/call", { name: "video_nonsense", arguments: {} }));
  assert.equal(res.status, 200);
  const result = (await jsonBody(res)).result as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]!.text) as { error: { code: string } };
  assert.equal(payload.error.code, "OPERATION_INVALID");
});

test("HTTP: GET → 405 + Allow: POST (no SSE stream offered)", async () => {
  const res = await fetch(`${serveBase}/mcp`, { method: "GET" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("HTTP: HEAD → 405", async () => {
  const res = await fetch(`${serveBase}/mcp`, { method: "HEAD" });
  assert.equal(res.status, 405);
});

test("HTTP: non-POST/GET/HEAD/DELETE method → 405 + Allow: POST", async () => {
  const res = await fetch(`${serveBase}/mcp`, { method: "PUT", body: "{}" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("HTTP: DELETE session → 204, then the dead session → 404 (resync signal)", async () => {
  const init = await post(serveBase, rpc("initialize", { protocolVersion: "2025-06-18" }));
  const session = init.headers.get("mcp-session-id")!;

  const deleted = await fetch(`${serveBase}/mcp`, {
    method: "DELETE",
    headers: { "Mcp-Session-Id": session },
  });
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");

  const dead = await post(serveBase, rpc("tools/list"), { "Mcp-Session-Id": session });
  assert.equal(dead.status, 404);
  const body = await jsonBody(dead);
  assert.equal((body.error as { code: number }).code, -32600);
  assert.equal("id" in body, false); // transport errors carry no id
});

test("HTTP: DELETE without a session header is still 204", async () => {
  const res = await fetch(`${serveBase}/mcp`, { method: "DELETE" });
  assert.equal(res.status, 204);
});

test("HTTP: another path → 404", async () => {
  const res = await fetch(`${serveBase}/other`, {
    method: "POST",
    body: rpc("tools/list"),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(res.status, 404);
});

test("HTTP: malformed JSON body → 400 with -32700 and no id", async () => {
  const res = await post(serveBase, `{"jsonrpc":`);
  assert.equal(res.status, 400);
  const body = await jsonBody(res);
  assert.equal((body.error as { code: number }).code, -32700);
  assert.equal("id" in body, false);
});

test("HTTP: non-object JSON body → 400 with -32600", async () => {
  const res = await post(serveBase, "42");
  assert.equal(res.status, 400);
  const body = await jsonBody(res);
  assert.equal((body.error as { code: number }).code, -32600);
});

test("HTTP: JSON-RPC response object from the client → 202 (accepted, not dispatched)", async () => {
  const res = await post(serveBase, JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }));
  assert.equal(res.status, 202);
});

test("HTTP: non-local Origin → 403 with an id-less JSON-RPC error body", async () => {
  const res = await post(serveBase, rpc("tools/list"), { Origin: "http://evil.example" });
  assert.equal(res.status, 403);
  const body = await jsonBody(res);
  assert.equal((body.error as { code: number }).code, -32600);
  assert.equal("id" in body, false);
});

test("HTTP: localhost Origin with a port is allowed (dev-server shape)", async () => {
  const res = await post(serveBase, rpc("tools/list"), { Origin: "http://localhost:5173" });
  assert.equal(res.status, 200);
});

test("HTTP: unknown MCP-Protocol-Version header → 400 + -32600 (2026-era fallback trigger)", async () => {
  const res = await post(serveBase, rpc("tools/list"), { "MCP-Protocol-Version": "2026-07-28" });
  assert.equal(res.status, 400);
  const body = await jsonBody(res);
  assert.equal((body.error as { code: number }).code, -32600);
});

test("HTTP: absent MCP-Protocol-Version header is fine (2025-03-26 semantics)", async () => {
  const res = await post(serveBase, rpc("tools/list"));
  assert.equal(res.status, 200);
});

test("HTTP: body over the 10 MB cap → 413", async () => {
  const res = await post(serveBase, "x".repeat(10 * 1024 * 1024 + 1));
  assert.equal(res.status, 413);
});

test("HTTP: token mode — missing/wrong bearer → 401 + WWW-Authenticate; correct → 200", async () => {
  const noAuth = await post(tokenBase, rpc("tools/list"));
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.headers.get("www-authenticate"), "Bearer");

  const wrong = await post(tokenBase, rpc("tools/list"), { Authorization: "Bearer nope" });
  assert.equal(wrong.status, 401);

  const right = await post(tokenBase, rpc("tools/list"), { Authorization: "Bearer sekrit" });
  assert.equal(right.status, 200);
  const tools = ((await jsonBody(right)).result as { tools: unknown[] }).tools;
  assert.equal(tools.length, TOOLS.length);
});

test("HTTP: off-loopback --host without --token refuses to start (exit 1, OPERATION_INVALID)", async () => {
  const r = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const p = spawn(process.execPath, [CLI, "mcp-serve", "--host", "0.0.0.0", "--port", "0"]);
    let stderr = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d: string) => (stderr += d));
    p.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(r.code, 1);
  assert.ok(!r.stderr.includes("listening"), `must not listen; stderr: ${r.stderr}`);
  const payload = JSON.parse(r.stderr.trim().split("\n").pop()!) as { error: { code: string } };
  assert.equal(payload.error.code, "OPERATION_INVALID");
});

test("isLoopbackHost truth table (token-required fence)", () => {
  for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "127.0.0.9"]) {
    assert.ok(isLoopbackHost(h), `${h} should be loopback`);
  }
  for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com", "10.0.0.1"]) {
    assert.ok(!isLoopbackHost(h), `${h} should NOT be loopback`);
  }
});

test("HTTP: server stdout stays clean (URL and errors go to stderr only)", () => {
  assert.equal(serveStdout, "");
});

// Stdio byte-identity regressions: the handleMessage refactor must not change
// one byte of the stdio transport's output (T16 is refactor + addition).

test("stdio: initialize response bytes are unchanged (echoed version)", async () => {
  const lines = await stdioExchange(
    [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })],
    1,
  );
  assert.deepEqual(lines, [
    '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"video-toolkit","version":"0.1.0"}}}',
  ]);
});

test("stdio: initialize without a protocolVersion still answers 2024-11-05", async () => {
  const lines = await stdioExchange([JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" })], 1);
  assert.deepEqual(lines, [
    '{"jsonrpc":"2.0","id":2,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"video-toolkit","version":"0.1.0"}}}',
  ]);
});

test("stdio: initialize with an unknown version echoes it (historical behavior)", async () => {
  const lines = await stdioExchange(
    [JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "1999-01-01" } })],
    1,
  );
  assert.deepEqual(lines, [
    '{"jsonrpc":"2.0","id":3,"result":{"protocolVersion":"1999-01-01","capabilities":{"tools":{}},"serverInfo":{"name":"video-toolkit","version":"0.1.0"}}}',
  ]);
});

test("stdio: ping response bytes are unchanged", async () => {
  const lines = await stdioExchange([JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })], 1);
  assert.deepEqual(lines, ['{"jsonrpc":"2.0","id":7,"result":{}}']);
});

test("stdio: unknown method error bytes are unchanged", async () => {
  const lines = await stdioExchange([JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/list" })], 1);
  assert.deepEqual(lines, ['{"jsonrpc":"2.0","id":5,"error":{"code":-32601,"message":"method not found: resources/list"}}']);
});

test("stdio: tool failure isError bytes are unchanged", async () => {
  const lines = await stdioExchange(
    [JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "video_nonsense", arguments: {} } })],
    1,
  );
  assert.deepEqual(lines, [
    '{"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"{\\"error\\":{\\"code\\":\\"OPERATION_INVALID\\",\\"message\\":\\"unknown tool: video_nonsense\\"}}"}],"isError":true}}',
  ]);
});

test("stdio: malformed JSON, notifications and unknown notifications stay silent", async () => {
  const lines = await stdioExchange(
    [
      "this is not json",
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", method: "some/unknown/notification" }),
      JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" }),
    ],
    1,
  );
  assert.deepEqual(lines, ['{"jsonrpc":"2.0","id":11,"result":{}}']); // exactly one line
});

// ---- T20: progress over SSE (R6's committed checklist) ----

interface SseFrame {
  event: string;
  data: string;
}

/** parse the committed framing: every frame is `event: message\ndata: <one
 * JSON-RPC object>` dispatched by a blank line; the stream ends with one. */
function parseSse(body: string): SseFrame[] {
  assert.ok(body.endsWith("\n\n"), `stream must end with a blank line: ${JSON.stringify(body.slice(-40))}`);
  return body.slice(0, -2).split("\n\n").map((f) => {
    const m = /^event: (.*)\ndata: (.*)$/.exec(f);
    assert.ok(m, `frame not in event+data form: ${JSON.stringify(f)}`);
    assert.equal(m[1], "message");
    assert.ok(!m[2]!.includes("\n"), "data must be exactly one JSON line");
    return { event: m[1]!, data: m[2]! };
  });
}

interface ProgressParams {
  progressToken: unknown;
  progress: number;
  total: number;
  message: string;
}

test("sink: dual-gate throttle + strict monotonicity (fake clock, no real sleeps)", () => {
  const frames: { params: ProgressParams }[] = [];
  let clock = 0;
  const sink = createProgressSink(42, (n) => frames.push(n as { params: ProgressParams }), () => clock);

  sink({ percent: null, timeSec: 0.5 }); // null percent → never emitted
  sink({ percent: 0.9, timeSec: 0.3 }); // <1.0 above the 0-domain start → suppressed
  clock = 100;
  sink({ percent: 2.0, timeSec: 0.4 }); // time gate open (first emit), Δ2.0 → EMIT
  clock = 200;
  sink({ percent: 50, timeSec: 10 }); // only 100 ms since emit → suppressed
  clock = 350; // exactly 250 ms since emit — boundary passes (>=)
  sink({ percent: 50, timeSec: 10 }); // EMIT (same percent, 250 ms elapsed)
  clock = 400;
  sink({ percent: 99, timeSec: 19.8 }); // 50 ms since emit → suppressed
  clock = 700;
  sink({ percent: 50.9, timeSec: 10.2 }); // time OK, Δ0.9 <1.0 → suppressed
  sink({ percent: 49, timeSec: 9.9 }); // regression below lastSent → suppressed
  sink({ percent: 51.0, timeSec: 10.2 }); // Δ exactly 1.0 — boundary → EMIT
  clock = 1200;
  sink({ percent: 100, timeSec: 20 }); // EMIT; lastSent tracks only emissions

  assert.deepEqual(
    frames.map((f) => f.params.progress),
    [2.0, 50, 51.0, 100],
  );
  for (const f of frames) {
    assert.equal(f.params.progressToken, 42); // integer echoed verbatim
    assert.equal(f.params.total, 100);
    assert.equal(typeof f.params.message, "string");
  }
});

test("sink: token is echoed verbatim in JSON — string stays quoted, integer stays a number", () => {
  const stringFrames: string[] = [];
  createProgressSink("render-tok", (n) => stringFrames.push(JSON.stringify(n)), () => 0)({
    percent: 5,
    timeSec: 1,
  });
  assert.equal(stringFrames.length, 1);
  assert.ok(stringFrames[0]!.includes('"progressToken":"render-tok"'));

  const intFrames: string[] = [];
  createProgressSink(7, (n) => intFrames.push(JSON.stringify(n)), () => 0)({ percent: 5, timeSec: 1 });
  assert.ok(intFrames[0]!.includes('"progressToken":7')); // never stringified
  assert.ok(!intFrames[0]!.includes('"progressToken":"7"'));
});

test("sink: (T26) a provided message wins verbatim; absent keeps the historical rendering-time message", () => {
  const frames: { params: ProgressParams }[] = [];
  let clock = 0;
  const sink = createProgressSink("t", (n) => frames.push(n as { params: ProgressParams }), () => clock);
  sink({ percent: 5, timeSec: 1.234, message: "plan 2/3 (b.json): 45% — overall 62%" }); // batch shape
  clock = 300; // clear the ≥250 ms gate for the second emit
  sink({ percent: 6, timeSec: 2.5 }); // render/preview shape — no message field
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.params.message, "plan 2/3 (b.json): 45% — overall 62%"); // verbatim passthrough
  assert.equal(frames[1]!.params.message, "rendering 2.5s"); // the pre-T26 default, one decimal
});

test("SSE: token-carrying tools/call video_render streams progress, closes with the plain-path result", async () => {
  // plain path first: no token → plain JSON render, the comparison baseline
  const plain = await post(serveBase, rpc("tools/call", { name: "video_render", arguments: { plan: SSE_PLAN } }));
  assert.equal(plain.status, 200);
  assert.ok(plain.headers.get("content-type")!.startsWith("application/json"));
  assert.ok(plain.headers.get("content-length"));
  const plainObj = (await jsonBody(plain)) as {
    id: number;
    result: { content: { text: string }[] };
  };
  const plainPayload = JSON.parse(plainObj.result.content[0]!.text) as Record<string, unknown>;

  // streamed path: same plan (force: the plain render above owns the output)
  const res = await post(
    serveBase,
    rpc("tools/call", {
      name: "video_render",
      arguments: { plan: SSE_PLAN, force: true },
      _meta: { progressToken: "sse-render-token" },
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")!.startsWith("text/event-stream"));
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  assert.equal(res.headers.get("connection"), "keep-alive");
  assert.equal(res.headers.get("content-length"), null); // chunked, self-delimiting

  const frames = parseSse(await res.text());
  const progress = frames.slice(0, -1).map((f) => JSON.parse(f.data) as { method: string; params: ProgressParams });
  const finalFrame = JSON.parse(frames[frames.length - 1]!.data) as {
    id: number;
    result: { content: { text: string }[] };
  };

  // ≥2 strictly-increasing progress notifications, token echoed, total 100
  assert.ok(progress.length >= 2, `expected >=2 progress notifications, got ${progress.length}`);
  let prev = -Infinity;
  for (const n of progress) {
    assert.equal(n.method, "notifications/progress");
    assert.equal(n.params.progressToken, "sse-render-token"); // verbatim string
    assert.equal(n.params.total, 100);
    assert.ok(n.params.progress > prev, `progress must strictly increase: ${n.params.progress} after ${prev}`);
    // (T26 regression lock) video_render messages stay BYTE-IDENTICAL to
    // pre-T26 — `rendering <t>s`, one decimal, never a batch-style message
    assert.match(n.params.message, /^rendering \d+\.\ds$/, `render message drifted: ${n.params.message}`);
    prev = n.params.progress;
  }

  // the last frame IS the response: same object the plain path returned
  const ssePayload = JSON.parse(finalFrame.result.content[0]!.text) as Record<string, unknown>;
  delete plainPayload.wallMs; // wall-clock differs by construction
  delete ssePayload.wallMs;
  assert.deepEqual(ssePayload, plainPayload); // output/mode/encoder/timeline/command/outputDuration identical
  await stat(path.join(dir, "sse-out.mp4"));
});

test("SSE: integer progressToken echoed verbatim (unquoted) during a render", async () => {
  const res = await post(
    serveBase,
    rpc("tools/call", {
      name: "video_render",
      arguments: { plan: SSE_PLAN, force: true },
      _meta: { progressToken: 42 },
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")!.startsWith("text/event-stream"));
  const frames = parseSse(await res.text());
  assert.ok(frames.length >= 2, "response-only stream would have exactly 1 frame");
  const progress = frames.slice(0, -1).map((f) => JSON.parse(f.data) as { params: ProgressParams });
  assert.ok(progress.length >= 1);
  for (const n of progress) {
    assert.equal(n.params.progressToken, 42); // number, never "42"
    assert.equal(typeof n.params.progressToken, "number");
  }
  assert.ok(frames.some((f) => f.data.includes('"progressToken":42')), "raw JSON must carry the unquoted integer");
  const finalFrame = JSON.parse(frames[frames.length - 1]!.data) as { result: { content: { text: string }[] } };
  const payload = JSON.parse(finalFrame.result.content[0]!.text) as { mode: string; output: string };
  assert.equal(payload.mode, "final");
});

test("SSE: non-progress tool with a token → response-only stream, frame byte-identical to the plain body", async () => {
  const sse = await post(
    serveBase,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 31337,
      method: "tools/call",
      params: { name: "video_inspect", arguments: { input: FIXTURE }, _meta: { progressToken: "tok" } },
    }),
  );
  assert.equal(sse.status, 200);
  assert.ok(sse.headers.get("content-type")!.startsWith("text/event-stream"));
  const frames = parseSse(await sse.text());
  assert.equal(frames.length, 1, "inspect has no progress wiring — exactly the response frame");

  const plain = await post(
    serveBase,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 31337,
      method: "tools/call",
      params: { name: "video_inspect", arguments: { input: FIXTURE } },
    }),
  );
  const plainBody = await plain.text();
  assert.equal(frames[0]!.data, plainBody); // byte-identical, id included
});

test("SSE: tool failure with a token → the isError result as the single final frame (error paths change NOT at all)", async () => {
  const req = (withToken: boolean): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 777,
      method: "tools/call",
      params: {
        name: "video_nonsense",
        arguments: {},
        ...(withToken ? { _meta: { progressToken: 1 } } : {}),
      },
    });
  const sse = await post(serveBase, req(true));
  assert.ok(sse.headers.get("content-type")!.startsWith("text/event-stream"));
  const frames = parseSse(await sse.text());
  assert.equal(frames.length, 1);
  const plain = await post(serveBase, req(false));
  assert.equal(frames[0]!.data, await plain.text()); // identical bytes
  const parsed = JSON.parse(frames[0]!.data) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(parsed.result.isError, true);
});

test("degradation: no-token tools/call stays plain application/json (regression lock)", async () => {
  const res = await post(serveBase, rpc("tools/call", { name: "video_inspect", arguments: { input: FIXTURE } }));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")!.startsWith("application/json"));
  assert.ok(res.headers.get("content-length"));
  const result = (await jsonBody(res)).result as { isError?: boolean };
  assert.notEqual(result.isError, true);
});

test("degradation: non-conforming progressToken (float/object) is treated as absent → plain JSON", async () => {
  for (const bad of [1.5, { id: "x" }]) {
    const res = await post(
      serveBase,
      rpc("tools/call", {
        name: "video_inspect",
        arguments: { input: FIXTURE },
        _meta: { progressToken: bad },
      }),
    );
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")!.startsWith("application/json"), `token ${JSON.stringify(bad)}`);
  }
});

test("degradation: tools/list WITH a progressToken stays plain JSON (non-tools/call never streams)", async () => {
  const res = await post(serveBase, rpc("tools/list", { _meta: { progressToken: "nope" } }));
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")!.startsWith("application/json"));
  const tools = ((await jsonBody(res)).result as { tools: unknown[] }).tools;
  assert.equal(tools.length, TOOLS.length);
});

test("degradation: notifications/cancelled → 202, accepted and ignored (renders are never cancelled)", async () => {
  const res = await post(
    serveBase,
    rpc("notifications/cancelled", { requestId: 999, reason: "test" }, true),
  );
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("gates precede the stream: token-carrying tools/call with a foreign Origin → 403, no stream", async () => {
  const res = await post(
    serveBase,
    rpc("tools/call", {
      name: "video_render",
      arguments: { plan: SSE_PLAN, force: true },
      _meta: { progressToken: "t" },
    }),
    { Origin: "http://evil.example" },
  );
  assert.equal(res.status, 403);
  assert.ok(res.headers.get("content-type")!.startsWith("application/json"));
  const body = await jsonBody(res);
  assert.equal((body.error as { code: number }).code, -32600);
});

test("disconnect mid-stream: the render still finishes and the server stays healthy (disconnect ≠ cancellation)", async () => {
  const ac = new AbortController();
  const res = await fetch(`${serveBase}/mcp`, {
    method: "POST",
    body: rpc("tools/call", {
      name: "video_preview",
      arguments: { plan: SSE_PLAN_B },
      _meta: { progressToken: 9 },
    }),
    headers: { "Content-Type": "application/json" },
    signal: ac.signal,
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")!.startsWith("text/event-stream"));
  ac.abort(); // hang up mid-render
  await res.text().catch(() => {}); // aborted read — expected

  // the render FINISHES (guard discards the response; nothing is cancelled)
  const out = path.join(dir, "sse-out-b.preview.mp4");
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await stat(out);
      break;
    } catch {
      assert.ok(Date.now() < deadline, "render did not finish after client disconnect");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const follow = await post(serveBase, rpc("tools/list"));
  assert.equal(follow.status, 200);
});

test("stream-then-plain on the pooled connection: chunked framing is self-delimiting", async () => {
  const sse = await post(
    serveBase,
    rpc("tools/call", {
      name: "video_inspect",
      arguments: { input: FIXTURE },
      _meta: { progressToken: "reuse" },
    }),
  );
  const frames = parseSse(await sse.text());
  assert.equal(frames.length, 1);
  // immediately reuse the same origin (undici pools the connection)
  const plain = await post(serveBase, rpc("tools/list"));
  assert.equal(plain.status, 200);
  assert.ok(plain.headers.get("content-type")!.startsWith("application/json"));
  const tools = ((await jsonBody(plain)).result as { tools: unknown[] }).tools;
  assert.equal(tools.length, TOOLS.length);
});

test("stdio: a token-carrying tools/call emits exactly one response line — never a notification", async () => {
  const lines = await stdioExchange(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "video_inspect",
          arguments: { input: FIXTURE },
          _meta: { progressToken: "stdio-tok" },
        },
      }),
    ],
    1,
  );
  assert.equal(lines.length, 1); // stdout stays byte-identical protocol output
  assert.ok(!lines[0]!.includes("notifications/progress"));
  const parsed = JSON.parse(lines[0]!) as { id: number; result: { content: { text: string }[] } };
  assert.equal(parsed.id, 21);
  JSON.parse(parsed.result.content[0]!.text);
});

// ---- T23: batch progress over the SSE sink (R6's named future sink-firing) ----

/** delete every `wallMs` key at any depth — the only field allowed to differ
 * between two runs of the same batch (summary + per-render wall clocks). */
function stripWallMsDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripWallMsDeep);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "wallMs") continue;
      out[k] = stripWallMsDeep(val);
    }
    return out;
  }
  return v;
}

test("SSE: token-carrying tools/call video_render_batch streams monotonic OVERALL progress on a real multi-plan batch", async () => {
  const plans = ["batch-a.json", "batch-b.json", "batch-c.json"];

  // no-token degradation lock FIRST: the plain path renders the batch and is
  // the byte-identity baseline — plain application/json, explicit length
  const plain = await post(
    serveBase,
    rpc("tools/call", { name: "video_render_batch", arguments: { plans, jobs: 3 } }),
  );
  assert.equal(plain.status, 200);
  assert.ok(plain.headers.get("content-type")!.startsWith("application/json"));
  assert.ok(plain.headers.get("content-length"));
  const plainPayload = JSON.parse(
    ((await jsonBody(plain)).result as { content: { text: string }[] }).content[0]!.text,
  ) as Record<string, unknown>;

  // streamed: same batch, token attached, force (the plain run owns the outputs)
  const res = await post(
    serveBase,
    rpc("tools/call", {
      name: "video_render_batch",
      arguments: { plans, jobs: 3, force: true },
      _meta: { progressToken: "batch-tok" },
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")!.startsWith("text/event-stream"));
  assert.equal(res.headers.get("content-length"), null); // chunked, self-delimiting

  const frames = parseSse(await res.text());
  const progress = frames
    .slice(0, -1)
    .map((f) => JSON.parse(f.data) as { method: string; params: ProgressParams });
  const finalFrame = JSON.parse(frames[frames.length - 1]!.data) as {
    id: number;
    result: { content: { text: string }[] };
  };

  // ≥2 strictly-increasing overall frames with total:100, token verbatim —
  // the sink's dual gate (≥250 ms AND ≥1.0 point) applied to the AGGREGATE
  assert.ok(progress.length >= 2, `expected >=2 overall progress frames, got ${progress.length}`);
  let prev = -Infinity;
  for (const n of progress) {
    assert.equal(n.method, "notifications/progress");
    assert.equal(n.params.progressToken, "batch-tok");
    assert.equal(n.params.total, 100);
    assert.ok(n.params.progress >= 0 && n.params.progress <= 100, "overall stays in the 0-100 total domain");
    assert.ok(n.params.progress > prev, `overall must strictly increase: ${n.params.progress} after ${prev}`);
    // (T26) every overall frame's message names the in-flight plan — FIXED
    // template `plan i/N (basename): P% — overall O%` with i↔basename LOCKED
    // to the expanded plan order (1=batch-a.json, 2=batch-b.json, 3=batch-c.json)
    const m = /^plan ([1-3])\/3 \((batch-[abc]\.json)\): (\d{1,3})% — overall (\d{1,3})%$/.exec(
      n.params.message,
    );
    assert.ok(m, `message not in template: ${JSON.stringify(n.params.message)}`);
    assert.equal(
      m![2],
      ["batch-a.json", "batch-b.json", "batch-c.json"][Number(m![1]) - 1],
      "i and basename must name the SAME expanded-order plan",
    );
    assert.ok(Number(m![3]) <= 100 && Number(m![4]) <= 100, "display percents stay in 0-100");
    prev = n.params.progress;
  }

  // the final frame IS the unchanged BatchReport — byte-identical to the
  // plain path modulo the inherently variable wallMs (summary + per-render)
  const ssePayload = JSON.parse(finalFrame.result.content[0]!.text) as Record<string, unknown>;
  assert.deepEqual(stripWallMsDeep(ssePayload), stripWallMsDeep(plainPayload));
  const report = ssePayload as unknown as { summary: { rendered: number; failed: number; jobs: number } };
  assert.equal(report.summary.rendered, 3);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.jobs, 3);
});

test("stdio: token-carrying tools/call video_render_batch emits exactly one response line — never a notification", async () => {
  const lines = await stdioExchange(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "video_render_batch",
          arguments: { plans: ["batch-a.json"], jobs: 1, force: true },
          _meta: { progressToken: "stdio-batch" },
        },
      }),
    ],
    1,
  );
  assert.equal(lines.length, 1); // stdio passes no sink — no aggregation, no notifications
  assert.ok(!lines[0]!.includes("notifications/progress"));
  const parsed = JSON.parse(lines[0]!) as { id: number; result: { content: { text: string }[] } };
  assert.equal(parsed.id, 22);
  const report = JSON.parse(parsed.result.content[0]!.text) as { summary: { rendered: number } };
  assert.equal(report.summary.rendered, 1);
});

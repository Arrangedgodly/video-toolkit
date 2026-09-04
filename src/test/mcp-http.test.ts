import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { runCapture } from "../media/ffprobe.js";
import { isLoopbackHost } from "../agent/mcp-http.js";

// T16 — MCP streamable-HTTP transport. Raw fetch (no HTTP client deps) against
// a spawned `video mcp-serve` on an OS-assigned port, plus stdio byte-identity
// regressions for the refactored dispatcher and the off-loopback token fence.

const FIXTURE = "fixture.mp4"; // 8s, audio + video
const CLI = path.resolve(import.meta.dirname, "..", "cli", "index.js");
const SERVER = path.resolve(import.meta.dirname, "..", "agent", "mcp-server.js");

const TOOLS = [
  "video_benchmark", "video_captions", "video_detect_filler", "video_detect_scenes",
  "video_detect_silence", "video_diagnose", "video_extract_frames", "video_find_highlights",
  "video_generate_proxy", "video_inspect", "video_measure_loudness", "video_plan",
  "video_preview", "video_render", "video_review_frames", "video_transcribe",
  "video_transitions", "video_validate",
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

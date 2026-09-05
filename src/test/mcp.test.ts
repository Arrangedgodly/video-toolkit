import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runCapture } from "../media/ffprobe.js";
import { CROSSFADE_KINDS } from "../core/schemas.js";
import { stdioProgressSink, type McpMessage } from "../agent/mcp-server.js";

const FIXTURE = "fixture.mp4"; // 8s, audio + video
const SERVER = path.resolve(import.meta.dirname, "..", "agent", "mcp-server.js");
const CLI = path.resolve(import.meta.dirname, "..", "cli", "index.js");
/** T30 stdio-progress fixtures: 20 s 720p final render — the T20 SSE sizing
 * (renders ≥ ~2 s wall, ffmpeg stats every ~0.5 s), long enough for several
 * engine events to clear the shared sink's 250 ms / 1.0-point dual gate, so
 * ≥2 notification LINES are guaranteed, not racy. */
const PROGRESS_FIXTURE = "progress-src.mp4";
const PROGRESS_PLAN = "progress-plan.json"; // final render → progress-out.mp4
let dir = "";
let child: ReturnType<typeof spawn> | null = null;
const responses = new Map<number, unknown>();
let nextId = 0;

function send(method: string, params?: Record<string, unknown>, notify = false): number {
  const id = ++nextId;
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!notify) msg.id = id;
  child?.stdin?.write(JSON.stringify(msg) + "\n");
  return id;
}

function request(method: string, params?: Record<string, unknown>, timeoutMs = 20000): Promise<Record<string, unknown>> {
  const id = send(method, params);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(poll);
        resolve(responses.get(id) as Record<string, unknown>);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`timeout waiting for response to ${method} (id ${id})`));
      }
    }, 20);
  });
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-toolkit-mcp-"));
  process.chdir(dir);
  const r = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "8", "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", FIXTURE,
  ]);
  assert.equal(r.code, 0, r.stderr);

  const pr = await runCapture("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "20", "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", PROGRESS_FIXTURE,
  ]);
  assert.equal(pr.code, 0, pr.stderr);
  await writeFile(
    PROGRESS_PLAN,
    JSON.stringify({
      version: 1,
      source: PROGRESS_FIXTURE,
      operations: [{ type: "trim", start: 0, end: 20 }],
      output: { path: "progress-out.mp4", mode: "final" },
    }),
  );

  child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "ignore"] });
  const buf: string[] = [];
  let pending = "";
  child.stdout!.on("data", (d: Buffer) => {
    pending += d.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      buf.push(line);
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id !== undefined) responses.set(msg.id, msg);
      } catch {
        // ignore malformed frames
      }
    }
  });
});

after(async () => {
  child?.kill();
  process.chdir(tmpdir());
  await rm(dir, { recursive: true, force: true });
});

test("initialize handshake", async () => {
  const r = await request("initialize", { protocolVersion: "2025-06-18" });
  const result = r.result as { serverInfo: { name: string }; capabilities: object };
  assert.equal(result.serverInfo.name, "video-toolkit");
  assert.ok(result.capabilities);
});

test("tools/list exposes exactly the CLI surface (21 tools)", async () => {
  const r = await request("tools/list");
  const tools = (r.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "video_benchmark", "video_captions", "video_detect_filler", "video_detect_scenes",
    "video_detect_silence", "video_diagnose", "video_doctor", "video_extract_frames",
    "video_find_highlights", "video_generate_proxy", "video_inspect", "video_measure_loudness",
    "video_plan", "video_plan_lint", "video_preview", "video_render", "video_render_batch",
    "video_review_frames", "video_transcribe", "video_transitions", "video_validate",
  ]);
});

test("tools/call: plan_lint returns suggestions for a valid-but-unclean plan (CLI parity)", async () => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile("lint-mcp.json", JSON.stringify({
    version: 1,
    source: FIXTURE,
    operations: [
      { type: "trim", start: 0, end: 4 },
      { type: "trim", start: 1, end: 3 }, // redundant: inside operation 1
      { type: "cut", start: 1, end: 2 },
      { type: "volume", db: 0 }, // identity
    ],
    output: { path: "lint-mcp-out.mp4" },
  }));
  const r = await request("tools/call", { name: "video_plan_lint", arguments: { plan: "lint-mcp.json" } });
  const result = r.result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(result.isError, true);
  const data = JSON.parse(result.content[0]!.text) as {
    suggestions: { code: string; operation?: number; fix?: string }[];
  };
  // deterministic order (operation index, then code): exactly the two defects
  assert.deepEqual(
    data.suggestions.map((s) => [s.code, s.operation]),
    [["REDUNDANT_TRIM", 2], ["NOOP_VOLUME", 4]],
  );
  assert.ok(data.suggestions[0]!.fix!.includes("remove operation 2"));
});

test("tools/call: measure_loudness returns the fixture's loudness (CLI parity)", async () => {
  const r = await request("tools/call", { name: "video_measure_loudness", arguments: { input: FIXTURE } });
  const result = r.result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(result.isError, true);
  const data = JSON.parse(result.content[0]!.text) as {
    inputI: number;
    inputTP: number;
    inputLRA: number;
    params: { targetI: number };
  };
  // FIXTURE carries a 440 Hz sine track: a real, finite measurement
  assert.ok(Number.isFinite(data.inputI));
  assert.ok(Number.isFinite(data.inputTP));
  assert.equal(typeof data.inputLRA, "number");
  assert.deepEqual(data.params, { targetI: -16 });
});

test("tools/call: transitions returns the live xfade catalog (CLI parity)", async () => {
  const r = await request("tools/call", { name: "video_transitions", arguments: {} });
  const result = r.result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(result.isError, true);
  const data = JSON.parse(result.content[0]!.text) as {
    transitions: { kind: string }[];
    count: number;
    ffmpeg: string;
  };
  assert.ok(Array.isArray(data.transitions) && data.transitions.length > 0);
  assert.equal(data.count, data.transitions.length);
  assert.ok(data.ffmpeg.length > 0);
  // the catalog IS the allowlist on this build (T17 equality era — every
  // allowlisted kind discoverable AND nothing beyond it)
  assert.equal(data.count, CROSSFADE_KINDS.length);
  const kinds = new Set(data.transitions.map((t) => t.kind));
  for (const k of CROSSFADE_KINDS) assert.ok(kinds.has(k), `catalog missing allowlisted kind ${k}`);
});

test("tools/call: inspect returns the fixture facts", async () => {
  const r = await request("tools/call", {
    name: "video_inspect",
    arguments: { input: FIXTURE },
  });
  const result = r.result as { isError?: boolean; content: { text: string }[] };
  assert.notEqual(result.isError, true);
  const data = JSON.parse(result.content[0]!.text) as { duration: number; video?: object };
  assert.ok(Math.abs(data.duration - 8) < 0.2);
  assert.ok(data.video);
});

test("tools/call: full plan workflow through MCP", async () => {
  const silence = await request("tools/call", {
    name: "video_detect_silence",
    arguments: { input: FIXTURE },
  });
  const silenceData = JSON.parse((silence.result as { content: { text: string }[] }).content[0]!.text) as {
    segments: unknown[];
  };
  assert.ok(Array.isArray(silenceData.segments)); // continuous tone: zero gaps

  const scaffold = await request("tools/call", {
    name: "video_plan",
    arguments: { input: FIXTURE },
  });
  const plan = JSON.parse((scaffold.result as { content: { text: string }[] }).content[0]!.text) as {
    operations: { type: string; start: number; end: number }[];
    output: { path: string };
  };
  plan.operations.push({ type: "cut", start: 2, end: 4 });
  plan.output.path = "edited.mp4";
  const { writeFile } = await import("node:fs/promises");
  await writeFile("plan.json", JSON.stringify(plan));

  const validated = await request("tools/call", { name: "video_validate", arguments: { plan: "plan.json" } });
  const v = JSON.parse((validated.result as { content: { text: string }[] }).content[0]!.text) as {
    valid: boolean; timelineDuration: number;
  };
  assert.equal(v.valid, true);
  assert.ok(Math.abs(v.timelineDuration - 6) < 0.01);

  const previewed = await request("tools/call", { name: "video_preview", arguments: { plan: "plan.json" } });
  const p = JSON.parse((previewed.result as { content: { text: string }[] }).content[0]!.text) as {
    outputDuration: number;
  };
  assert.ok(Math.abs(p.outputDuration - 6) < 0.5, `duration ${p.outputDuration}`);
});

test("tools/call: unknown tool returns isError with a payload", async () => {
  const r = await request("tools/call", { name: "video_nonsense", arguments: {} });
  const result = r.result as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0]!.text) as { error: { code: string } };
  assert.equal(payload.error.code, "OPERATION_INVALID");
});

test("bin-style invocation (argv[1] not ending in mcp-server.js) starts the server", async () => {
  // Reproduces how the npm bin runs the server: a symlink named `video-mcp`
  // -> dist/agent/mcp-server.js, so argv[1] does NOT end in "mcp-server.js".
  // The startup guard must resolve real paths on both sides, or the process
  // silently exits without ever answering `initialize`.
  const binLink = path.join(dir, "video-mcp");
  await symlink(SERVER, binLink);
  const proc = spawn(process.execPath, [binLink], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      const fail = setTimeout(() => reject(new Error("no response to initialize — server did not start")), 15000);
      let pending = "";
      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (d: string) => {
        pending += d;
        const nl = pending.indexOf("\n");
        if (nl >= 0) {
          clearTimeout(fail);
          resolve(pending.slice(0, nl));
        }
      });
      proc.on("exit", (code) => {
        clearTimeout(fail);
        reject(new Error(`server exited before responding (code ${code})`));
      });
      proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n",
      );
    });
    const msg = JSON.parse(line) as { result?: { serverInfo?: { name: string } } };
    assert.equal(msg.result?.serverInfo?.name, "video-toolkit");
  } finally {
    proc.kill();
    await rm(binLink, { force: true });
  }
});

// ---- T30: stdio progress notifications (R6's contract over JSON lines) ----

/** Spawn `video mcp` (the full CLI path), write the request lines, resolve ALL
 * stdout lines once the RESPONSE carrying `responseId` arrives — plus a short
 * grace window so an unexpected straggler (e.g. a notification after the
 * response) is captured and fails the exact-line assertions. Always WAITS for
 * the response instead of racing a fixed quiet timer (robust under full-suite
 * CPU contention, the stdioExchange precedent). */
function cliMcpExchange(lines: string[], responseId: number, graceMs = 350, timeoutMs = 30000): Promise<string[]> {
  const proc = spawn(process.execPath, [CLI, "mcp"], { stdio: ["pipe", "pipe", "ignore"] });
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
      if (out.some((l) => {
        try {
          return (JSON.parse(l) as { id?: unknown }).id === responseId;
        } catch {
          return false;
        }
      })) {
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

interface ProgressLine {
  jsonrpc: string;
  method: string;
  params: { progressToken: unknown; progress: number; total: number; message: string };
}

test("T30 unit: stdioProgressSink emits notifications/progress frames via the injected writer (fake clock)", () => {
  const frames: ProgressLine[] = [];
  let clock = 0;
  const msg: McpMessage & { jsonrpc?: string } = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "video_render", arguments: {}, _meta: { progressToken: "stdio-tok" } },
  };
  const sink = stdioProgressSink(msg, (n) => frames.push(n as ProgressLine), () => clock);
  assert.ok(sink, "a conforming token must produce a sink");

  sink({ percent: null, timeSec: 0.5 }); // null percent → never a line
  clock = 100;
  sink({ percent: 2.5, timeSec: 0.5 }); // first eligible event → line
  clock = 200;
  sink({ percent: 80, timeSec: 16 }); // <250 ms since the emit → suppressed
  clock = 400; // ≥250 ms since the emit — time gate open again
  sink({ percent: 3.55, timeSec: 0.8 }); // Δ1.05 ≥ 1.0 → line (regression below 80 is the sink's fence)

  // the SAME shared createProgressSink dual gate (≥250 ms AND ≥1.0 point),
  // strict monotonicity of EMITTED progress — no duplicated throttle logic
  assert.deepEqual(
    frames.map((f) => f.params.progress),
    [2.5, 3.55],
  );
  for (const f of frames) {
    assert.equal(f.jsonrpc, "2.0");
    assert.equal(f.method, "notifications/progress");
    assert.equal(f.params.progressToken, "stdio-tok"); // verbatim string
    assert.equal(f.params.total, 100);
    assert.equal(typeof f.params.message, "string");
  }
  // each frame is ONE JSON object — the live writer appends the "\n"
  assert.ok(JSON.stringify(frames[0]).includes('"method":"notifications/progress"'));

  // integer token stays an integer in the frame (never stringified)
  const intFrames: string[] = [];
  const intSink = stdioProgressSink(
    { method: "tools/call", params: { _meta: { progressToken: 42 } } },
    (n) => intFrames.push(JSON.stringify(n)),
    () => 0,
  );
  assert.ok(intSink);
  intSink({ percent: 5, timeSec: 1 });
  assert.ok(intFrames[0]!.includes('"progressToken":42'));
  assert.ok(!intFrames[0]!.includes('"progressToken":"42"'));
});

test("T30 unit: no sink — and never a write — for no-token / non-conforming / non-tools/call shapes", () => {
  const write = (): void => {
    throw new Error("writer must not be called");
  };
  type WireMessage = McpMessage & { jsonrpc?: string };
  const degraded: WireMessage[] = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "video_render", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "video_render", arguments: {}, _meta: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "video_render", arguments: {}, _meta: { progressToken: 1.5 } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "video_render", arguments: {}, _meta: { progressToken: { x: 1 } } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "video_render", arguments: {}, _meta: { progressToken: null } } },
    // R6 degradation rule: a token on a non-tools/call method never opts in
    { jsonrpc: "2.0", id: 6, method: "tools/list", params: { _meta: { progressToken: "nope" } } },
  ];
  for (const msg of degraded) {
    assert.equal(stdioProgressSink(msg, write), undefined, JSON.stringify(msg));
  }
  // conforming shapes DO get a sink (string + integer), tools/call only
  assert.ok(stdioProgressSink({ method: "tools/call", params: { _meta: { progressToken: "s" } } }, write));
  assert.ok(stdioProgressSink({ method: "tools/call", params: { _meta: { progressToken: 7 } } }, write));
});

test("T30 integration: token-carrying tools/call video_render over `video mcp` — notification LINES then exactly one response line", async () => {
  const id = 101;
  const lines = await cliMcpExchange(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "video_render",
          arguments: { plan: PROGRESS_PLAN },
          _meta: { progressToken: "stdio-render" },
        },
      }),
    ],
    id,
  );
  assert.ok(lines.length >= 3, `expected >=2 notifications + 1 response, got ${lines.length}: ${lines.join(" | ")}`);

  // every line BEFORE the last is a notification; the LAST line is the response
  const notes = lines.slice(0, -1).map((l) => JSON.parse(l) as ProgressLine);
  assert.ok(notes.length >= 2, `expected >=2 progress lines, got ${notes.length}`);
  let prev = -Infinity;
  for (const n of notes) {
    assert.equal(n.method, "notifications/progress");
    assert.equal(n.params.progressToken, "stdio-render"); // verbatim echo
    assert.equal(n.params.total, 100);
    assert.ok(n.params.progress > prev, `progress must strictly increase: ${n.params.progress} after ${prev}`);
    // video_render keeps the historical time message (T26 lock, stdio side)
    assert.match(n.params.message, /^rendering \d+\.\ds$/, `render message drifted: ${n.params.message}`);
    prev = n.params.progress;
  }

  const response = JSON.parse(lines[lines.length - 1]!) as {
    id: number;
    result: { isError?: boolean; content: { text: string }[] };
  };
  assert.equal(response.id, id); // exactly one response line, matching id, last
  assert.notEqual(response.result.isError, true);
  const payload = JSON.parse(response.result.content[0]!.text) as { mode: string; output: string };
  assert.equal(payload.mode, "final");
  assert.ok(payload.output.endsWith("progress-out.mp4")); // resolved absolute path
});

test("T30 integration: no-token tools/call video_render → exactly one response line, zero notifications (degradation lock)", async () => {
  const id = 102;
  const lines = await cliMcpExchange(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "video_render", arguments: { plan: PROGRESS_PLAN, force: true } },
      }),
    ],
    id,
  );
  assert.equal(lines.length, 1); // single response line — progress events fire, none surface
  assert.ok(!lines[0]!.includes("notifications/progress"));
  const response = JSON.parse(lines[0]!) as { id: number; result: { content: { text: string }[] } };
  assert.equal(response.id, id);
  const payload = JSON.parse(response.result.content[0]!.text) as { mode: string };
  assert.equal(payload.mode, "final");
});

test("T30 integration: tools/list WITH a token → response-only, no notifications (R6 degradation rule)", async () => {
  const id = 103;
  const lines = await cliMcpExchange(
    [JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: { progressToken: "nope" } } })],
    id,
  );
  assert.equal(lines.length, 1); // a token never opts a non-tools/call method in
  const response = JSON.parse(lines[0]!) as { id: number; result: { tools: unknown[] } };
  assert.equal(response.id, id);
  assert.equal(response.result.tools.length, 21);
});

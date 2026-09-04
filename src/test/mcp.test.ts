import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runCapture } from "../media/ffprobe.js";
import { CROSSFADE_KINDS } from "../core/schemas.js";

const FIXTURE = "fixture.mp4"; // 8s, audio + video
const SERVER = path.resolve(import.meta.dirname, "..", "agent", "mcp-server.js");
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

test("tools/list exposes exactly the CLI surface (17 tools)", async () => {
  const r = await request("tools/list");
  const tools = (r.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "video_benchmark", "video_captions", "video_detect_filler", "video_detect_scenes",
    "video_detect_silence", "video_diagnose", "video_extract_frames", "video_find_highlights",
    "video_generate_proxy", "video_inspect", "video_plan", "video_preview", "video_render",
    "video_review_frames", "video_transcribe", "video_transitions", "video_validate",
  ]);
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
  // every frozen crossfade kind must be discoverable here (T13's superset law)
  const kinds = new Set(data.transitions.map((t) => t.kind));
  for (const k of CROSSFADE_KINDS) assert.ok(kinds.has(k), `catalog missing frozen kind ${k}`);
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

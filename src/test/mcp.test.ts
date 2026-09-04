import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runCapture } from "../media/ffprobe.js";

const FIXTURE = "fixture.mp4"; // 8s, audio + video
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

  const server = path.resolve(import.meta.dirname, "..", "agent", "mcp-server.js");
  child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "ignore"] });
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

test("tools/list exposes the workflow", async () => {
  const r = await request("tools/list");
  const tools = (r.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  for (const expected of [
    "video_inspect", "video_plan", "video_validate", "video_preview", "video_render",
    "video_detect_silence", "video_detect_scenes", "video_extract_frames",
    "video_generate_proxy", "video_diagnose", "video_benchmark",
  ]) {
    assert.ok(tools.includes(expected), `missing ${expected}`);
  }
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

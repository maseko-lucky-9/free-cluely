/**
 * Stub-server test for the Ollama transport.
 *
 * No Ollama, no Electron, no GUI. Boots an HTTP stub that records every request
 * body and returns scripted responses, then drives the compiled LLMHelper
 * against it. Exit code is the artifact.
 *
 *   npm run build && node test/llmhelper.test.mjs
 *
 * Mutation-check it: break the embedding denylist in selectModel(), or delete
 * the `await this.ensureReady()` in callOllama, and this must go red.
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// --- fixtures ---------------------------------------------------------------

// /api/tags sorts by modified_at DESC, so models[0] is the most recently pulled.
// Putting an embedding model first is the exact trap the old code fell into.
const TAGS_FIXTURE = {
  models: [
    { name: "bge-m3:latest", capabilities: ["embedding"] },
    { name: "nomic-embed-text:latest", capabilities: ["embedding"] },
    { name: "embeddinggemma:latest", capabilities: ["embedding"] },
    { name: "mxbai-embed-large:latest", capabilities: ["embedding"] },
    { name: "deepseek-coder-v2:16b", capabilities: ["completion"] },
    { name: "qwen2.5vl:7b", capabilities: ["completion", "vision"] },
    { name: "gemma4:12b", capabilities: ["completion", "vision", "thinking"] },
  ],
};
const EMBEDDING_MODELS = TAGS_FIXTURE.models
  .filter((m) => m.capabilities.includes("embedding"))
  .map((m) => m.name);

const GOOD_SOLUTION = JSON.stringify({
  solution: {
    code: "def find_it(seq):\n    return 5",
    language: "Python",
    explanation: "XOR every element.",
    thoughts: ["XOR cancels pairs"],
    time_complexity: "O(n)",
    space_complexity: "O(1)",
  },
});
const GOOD_CLASSIFICATION = JSON.stringify({
  problem_type: "coding",
  language: "Python",
  problem_statement: "Find the integer that appears an odd number of times.",
});
const GARBAGE_PROSE =
  "Sure! Here's how I'd approach this problem. First, you'd want to iterate " +
  "over the array and count occurrences. It's a classic interview question.";

// A 1x1 PNG — content is irrelevant, only that a real file is read.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmhelper-test-"));
const fixturePng = path.join(tmpDir, "problem.png");
fs.writeFileSync(fixturePng, PNG_1PX);

// --- stub server ------------------------------------------------------------

const requests = [];
/** @type {{status:number, body?:string, delayMs?:number}} */
let script = { status: 200, body: GOOD_SOLUTION };
let generateCount = 0;

const server = http.createServer((req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(TAGS_FIXTURE));
    return;
  }
  if (req.url !== "/api/generate") {
    res.writeHead(404);
    res.end();
    return;
  }

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = JSON.parse(raw);
    requests.push(body);
    generateCount++;

    const current = typeof script === "function" ? script(generateCount) : script;
    if (current.delayMs) await new Promise((r) => setTimeout(r, current.delayMs));

    if (current.status !== 200) {
      res.writeHead(current.status, { "Content-Type": "application/json" });
      res.end(current.body ?? JSON.stringify({ error: "scripted failure" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ response: current.body, done: true, done_reason: current.doneReason ?? "stop" }));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${server.address().port}`;

// --- helpers ----------------------------------------------------------------

let passed = 0;
const failures = [];

async function check(name, fn) {
  requests.length = 0;
  generateCount = 0;
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

async function rejects(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, but it resolved");
}

function freshHelper(model) {
  delete require.cache[require.resolve("../dist-electron/LLMHelper.js")];
  const { LLMHelper } = require("../dist-electron/LLMHelper.js");
  return new LLMHelper(model, stubUrl);
}

// --- tests ------------------------------------------------------------------

console.log(`\nStub server on ${stubUrl}\n`);

await check("never binds to an embedding model (models[0] is one)", async () => {
  const helper = freshHelper();
  script = { status: 200, body: GOOD_SOLUTION };
  await helper.testConnection();
  const chosen = helper.getCurrentModel();
  assert.ok(
    !EMBEDDING_MODELS.includes(chosen),
    `selected embedding model "${chosen}"`,
  );
  assert.equal(chosen, "qwen2.5vl:7b", "should pick the first vision-capable model");
});

await check("rejects a non-vision model and falls back to a vision one", async () => {
  const helper = freshHelper("deepseek-coder-v2:16b");
  await helper.testConnection();
  assert.equal(helper.getCurrentModel(), "qwen2.5vl:7b");
});

await check("resolves a bare model name to its installed tag", async () => {
  const helper = freshHelper("qwen2.5vl");
  await helper.testConnection();
  assert.equal(helper.getCurrentModel(), "qwen2.5vl:7b");
});

await check("request body carries schema, num_ctx, keep_alive, temperature 0", async () => {
  const helper = freshHelper();
  script = (n) => ({ status: 200, body: n === 1 ? GOOD_CLASSIFICATION : GOOD_SOLUTION });
  await helper.solveImageProblem(fixturePng);

  assert.equal(requests.length, 2, "expected a classification call and a solution call");
  for (const [i, body] of requests.entries()) {
    assert.ok(body.format, `call ${i + 1}: missing format (JSON schema)`);
    assert.equal(typeof body.format, "object", `call ${i + 1}: format must be a schema, not "json"`);
    assert.equal(body.options.temperature, 0, `call ${i + 1}: temperature must be 0 for structured output`);
    assert.ok(body.options.num_ctx >= 8192, `call ${i + 1}: num_ctx too small (${body.options.num_ctx})`);
    assert.ok(body.options.num_predict > 0, `call ${i + 1}: missing num_predict`);
    assert.ok(body.keep_alive, `call ${i + 1}: missing keep_alive`);
    assert.equal(body.stream, false, `call ${i + 1}: stream must be false`);
    assert.equal(body.think, false, `call ${i + 1}: think:false is mandatory alongside format`);
    assert.ok(Array.isArray(body.images) && body.images.length === 1,
      `call ${i + 1}: the image must be sent to BOTH stages`);
    assert.ok(!EMBEDDING_MODELS.includes(body.model), `call ${i + 1}: embedding model on the wire`);
  }
});

await check("always sends think:false — omitting it with format returns an empty response", async () => {
  // Measured on Ollama 0.33.2: format set + think absent => response:"" because the
  // model spends its whole budget in the `thinking` field. This is not tuning.
  for (const model of ["qwen2.5vl:7b", "gemma4:12b"]) {
    requests.length = 0;
    const helper = freshHelper(model);
    script = { status: 200, body: GOOD_SOLUTION };
    await helper.chat("hi");
    assert.equal(requests[0].think, false, `${model}: think:false must always be sent`);
  }
});

await check("falls back gracefully if a model rejects the think field", async () => {
  const helper = freshHelper();
  let seen = 0;
  script = () => {
    seen++;
    return seen === 1
      ? { status: 400, body: '{"error":"model does not support thinking"}' }
      : { status: 200, body: GOOD_SOLUTION };
  };
  const out = await helper.chat("hi");
  assert.equal(requests.length, 2, "should retry once without think");
  assert.equal(requests[0].think, false);
  assert.ok(!("think" in requests[1]), "retry must drop the think field");
  assert.ok(out.includes("find_it"));
});

await check("truncated generation THROWS instead of returning a partial answer", async () => {
  const helper = freshHelper();
  script = { status: 200, body: '{"solution":{"code":"def f(', doneReason: "length" };
  const error = await rejects(() => helper.chat("hi"));
  assert.match(error.message, /output limit/i);
});

await check("garbage prose THROWS instead of being rendered as an answer", async () => {
  const helper = freshHelper();
  script = (n) => ({ status: 200, body: n === 1 ? GOOD_CLASSIFICATION : GARBAGE_PROSE });
  const error = await rejects(() => helper.solveImageProblem(fixturePng));
  assert.match(error.message, /did not return usable/i);
  // The specific regression: prose must never come back as solution.code.
  assert.ok(!error.solution, "must not return a fabricated solution object");
});

await check("a shapeless JSON object THROWS instead of spinning forever", async () => {
  const helper = freshHelper();
  script = (n) => ({ status: 200, body: n === 1 ? GOOD_CLASSIFICATION : '{"step": 1}' });
  const error = await rejects(() => helper.solveImageProblem(fixturePng));
  assert.match(error.message, /did not return usable solution/i);
});

await check("valid JSON lands in solution.code", async () => {
  const helper = freshHelper();
  script = (n) => ({ status: 200, body: n === 1 ? GOOD_CLASSIFICATION : GOOD_SOLUTION });
  const result = await helper.solveImageProblem(fixturePng);
  assert.equal(result.solution.code, "def find_it(seq):\n    return 5");
  assert.equal(result.solution.language, "Python");
  assert.equal(result.problemInfo.language, "Python", "language must be auto-detected, not hardcoded C#");
});

await check("apostrophes in prose survive the JSON repair pipeline", async () => {
  const helper = freshHelper();
  const withApostrophe = JSON.stringify({
    solution: { code: "x = 1", explanation: "Don't forget the base case.", thoughts: ["it's fine"] },
  });
  script = (n) => ({ status: 200, body: n === 1 ? GOOD_CLASSIFICATION : withApostrophe });
  const result = await helper.solveImageProblem(fixturePng);
  assert.equal(result.solution.explanation, "Don't forget the base case.");
});

await check("HTTP 500 THROWS", async () => {
  const helper = freshHelper();
  script = { status: 500 };
  const error = await rejects(() => helper.chat("hi"));
  assert.match(error.message, /500|error/i);
});

await check("a hung server aborts within the timeout budget", async () => {
  process.env.OLLAMA_TIMEOUT_MS = "1500";
  const helper = freshHelper();
  script = { status: 200, body: GOOD_SOLUTION, delayMs: 6000 };
  const startedAt = Date.now();
  const error = await rejects(() => helper.chat("hi"));
  const elapsed = Date.now() - startedAt;
  delete process.env.OLLAMA_TIMEOUT_MS;
  assert.ok(elapsed < 4000, `took ${elapsed}ms; should abort near the 1500ms budget`);
  assert.match(error.message, /did not respond within/i);
});

await check("caller cancellation aborts the in-flight request", async () => {
  const helper = freshHelper();
  script = { status: 200, body: GOOD_SOLUTION, delayMs: 5000 };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const startedAt = Date.now();
  const error = await rejects(() => helper.chat("hi", controller.signal));
  assert.ok(Date.now() - startedAt < 3000, "abort must not wait for the server");
  assert.match(error.message, /cancelled/i);
});

await check("audio is refused, never fabricated", async () => {
  const helper = freshHelper();
  const a = await rejects(() => helper.analyzeAudioFile("/tmp/whatever.mp3"));
  const b = await rejects(() => helper.analyzeAudioFromBase64("AAAA", "audio/webm"));
  for (const error of [a, b]) assert.match(error.message, /not available in local mode/i);
});

await check("unreachable Ollama gives an actionable error", async () => {
  delete require.cache[require.resolve("../dist-electron/LLMHelper.js")];
  const { LLMHelper } = require("../dist-electron/LLMHelper.js");
  const helper = new LLMHelper(undefined, "http://127.0.0.1:1");
  const error = await rejects(() => helper.chat("hi"));
  assert.match(error.message, /cannot reach ollama/i);
});


// --- screenshot failure messages -------------------------------------------

const { describeScreenshotFailure } = require("../dist-electron/screenshotErrors.js");

await check("dev-mode permission failure names the Electron entry, not the product", () => {
  // Verbatim from the failing run.
  const raw =
    'Command failed: screencapture -x -t jpg "/Users/x/screenshots/a.png"\ncould not create image from display\n';
  const out = describeScreenshotFailure(raw, {
    appName: "Meeting Notes Coder",
    exePath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    isPackaged: false,
    platform: "darwin",
  });
  assert.match(out, /Screen Recording/i, "must name the permission");
  assert.match(out, /System Settings/i, "must say where to grant it");
  // The whole point: in dev the entry is "Electron", NOT the product name.
  assert.match(out, /"Electron"/, "must name the entry the user will actually see");
  assert.match(out, /NOT "Meeting Notes Coder"/, "must warn the product name is absent");
  assert.match(out, /Electron\.app\/Contents\/MacOS\/Electron/, "must give the binary path");
  assert.ok(!/could not create image from display/.test(out), "must not leak the opaque message");
});

await check("packaged permission failure names the product itself", () => {
  const out = describeScreenshotFailure("could not create image from display", {
    appName: "Meeting Notes Coder",
    isPackaged: true,
    platform: "darwin",
  });
  assert.match(out, /enable "Meeting Notes Coder"/, "packaged app has its own entry");
  assert.ok(!/"Electron"/.test(out), "must not send a packaged user hunting for Electron");
});

await check("an unrelated capture failure is passed through, not mislabelled", () => {
  const out = describeScreenshotFailure("ENOSPC: no space left on device", { platform: "darwin" });
  assert.match(out, /ENOSPC/);
  assert.ok(!/Screen Recording/i.test(out), "must not blame permissions for a disk error");
});

// --- report -----------------------------------------------------------------

server.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`FAILED: ${f.name}\n${f.error.stack}\n`);
  process.exit(1);
}

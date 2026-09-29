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

const { describeScreenshotFailure, describeScreenCapturePermission, isLaunchedFromShell, survivesCaptureSanitizer } = require("../dist-electron/screenshotErrors.js");

await check("detects paths the capture tool would silently corrupt", () => {
  // Real observed failure: the capture tool strips spaces, redirecting the write
  // to a nonexistent dir while still reporting success.
  const real = "/Users/x/Library/Application Support/Meeting Notes Coder/screenshots/a.png";
  assert.equal(survivesCaptureSanitizer(real), false, "spaces must be detected as unsafe");
  assert.equal(
    survivesCaptureSanitizer("/var/folders/p2/abc123/T/11111111-2222-3333.png"),
    true,
    "a temp path of safe characters must pass"
  );
  // Exactly how the corruption manifests, for the record.
  assert.equal(
    real.replace(/[^a-zA-Z0-9._\-/]/g, ""),
    "/Users/x/Library/ApplicationSupport/MeetingNotesCoder/screenshots/a.png"
  );
});

await check("launch attribution is decided by ppid", () => {
  // Finder/Dock/open reparent to launchd; anything else came from a shell.
  assert.equal(isLaunchedFromShell(1), false, "ppid 1 = launchd = self-attributed");
  assert.equal(isLaunchedFromShell(90558), true, "a real shell pid means shell-attributed");
  assert.equal(isLaunchedFromShell(0), true, "unknown parent must not be treated as Finder");
});

await check("a shell-launched run says permission is attributed elsewhere", () => {
  // Verified on this machine: shell ancestry was zsh -> claude-code -> Claude.app,
  // so TCC consults Claude's entry, not the app's. Toggling the app does nothing.
  const out = describeScreenCapturePermission("denied", {
    appName: "Meeting Notes Coder",
    exePath: "/Applications/Meeting Notes Coder.app/Contents/MacOS/Meeting Notes Coder",
    isPackaged: true,
    launchedFromShell: true,
    responsibleHint: "Claude",
  });
  assert.match(out, /started from a shell/i, "must name the actual cause");
  assert.match(out, /Claude/, "must name the responsible process when known");
  assert.match(out, /will not help/i, "must say toggling this app's entry is useless here");
  assert.match(out, /open -a "Meeting Notes Coder"/, "must give the corrective launch");
  // The old advice was actively wrong; make sure it cannot come back.
  assert.ok(!/tccutil/.test(out), "tccutil advice was based on contaminated probes");
  assert.ok(!/com\.github\.Electron/.test(out), "dev bundle id is irrelevant under shell attribution");
});

await check("a Finder-launched denial points at the real macOS 26 pane", () => {
  const out = describeScreenCapturePermission("denied", {
    appName: "Meeting Notes Coder",
    isPackaged: true,
    launchedFromShell: false,
  });
  assert.match(out, /Screen & System Audio Recording/, "macOS 26 renamed the pane");
  assert.match(out, /switch "Meeting Notes Coder" ON/i, "must name the entry to enable");
  assert.match(out, /already ON.*OFF and\s+back ON/is, "must cover the stale-grant case");
  assert.ok(!/started from a shell/i.test(out), "must not blame the shell when self-attributed");
});

await check("not-determined asks for approval rather than blaming a denial", () => {
  const out = describeScreenCapturePermission("not-determined", {
    appName: "Meeting Notes Coder",
    isPackaged: true,
    launchedFromShell: false,
  });
  assert.match(out, /has not been granted yet/i);
  assert.ok(!/denied/i.test(out), "must not claim a denial that has not happened");
});

await check("the raw CLI error still routes into the permission explanation", () => {
  const raw = 'Command failed: screencapture -x -t jpg "/tmp/a.png"\ncould not create image from display\n';
  const out = describeScreenshotFailure(raw, { isPackaged: true, launchedFromShell: false, platform: "darwin" });
  assert.match(out, /Screen & System Audio Recording/);
  assert.ok(!/could not create image from display/.test(out), "must not leak the opaque message");
});

await check("an unrelated capture failure is passed through, not mislabelled", () => {
  const out = describeScreenshotFailure("ENOSPC: no space left on device", { platform: "darwin" });
  assert.match(out, /ENOSPC/);
  assert.match(out, /^Failed to take screenshot:/, "must pass the raw error through");
  assert.ok(!/Screen & System Audio Recording|permission/i.test(out),
    "must not blame permissions for a disk error");
});


// --- debug payload shape ----------------------------------------------------

const { buildDebugPayload } = require("../dist-electron/debugPayload.js");

await check("debug payload carries the fields the diff view reads", () => {
  // The view reads old_code/new_code; the LLM schema emits neither. Omitting them
  // left `!oldCode || !newCode` true forever and the section skeletoned.
  const out = buildDebugPayload("def old(): pass", {
    code: "def better(): pass",
    explanation: "tightened",
    thoughts: ["use a set"],
  });
  assert.equal(out.solution.old_code, "def old(): pass");
  assert.equal(out.solution.new_code, "def better(): pass", "new_code mirrors solution.code");
  assert.equal(out.solution.explanation, "tightened", "existing fields survive");
  assert.deepEqual(out.solution.thoughts, ["use a set"]);
});

await check("a debug run with no previous solution yields old_code null, not undefined", () => {
  const out = buildDebugPayload(null, { code: "x = 1" });
  assert.equal(out.solution.old_code, null, "must be explicit null so the view can branch");
  assert.equal(out.solution.new_code, "x = 1");
  assert.ok("old_code" in out.solution, "key must be present even when null");
});

await check("a solution missing code still produces both keys", () => {
  const out = buildDebugPayload(null, {});
  assert.equal(out.solution.old_code, null);
  assert.equal(out.solution.new_code, null);
});

// --- image budget -----------------------------------------------------------

const { downscaleWidth } = require("../dist-electron/imageBudget.js");

await check("a 2x Retina capture is shrunk to its logical width", () => {
  // 3024x1964 @144dpi measured at 4056 image tokens / 15.5s prompt-eval;
  // 1512 wide measured at 1484 tokens / 3.3s with the title still read correctly.
  const displays = [
    { width: 1512, height: 982, scaleFactor: 2 },
    { width: 3440, height: 1440, scaleFactor: 1 },
  ];
  assert.equal(downscaleWidth(3024, 1964, displays), 1512);
});

await check("a 1x external-display capture is left alone", () => {
  // 3440x1440 @72dpi has no spare detail; halving it destroys 2.3x of real text.
  const displays = [
    { width: 1512, height: 982, scaleFactor: 2 },
    { width: 3440, height: 1440, scaleFactor: 1 },
  ];
  assert.equal(downscaleWidth(3440, 1440, displays), null);
});

await check("a capture that matches no display is never resized on a guess", () => {
  const displays = [{ width: 1512, height: 982, scaleFactor: 2 }];
  assert.equal(downscaleWidth(3024, 1900, displays), null, "height mismatch");
  assert.equal(downscaleWidth(1512, 982, displays), null, "already logical size");
  assert.equal(downscaleWidth(3024, 1964, []), null, "no displays known");
});

// --- keep-alive & warm-up ---------------------------------------------------

await check("keep_alive outlives the observed solve-to-debug gap and is bounded", async () => {
  // app.log: 52 minutes between solve and debug, model cold both times at 10m.
  // -1 would never unload 6.6 GB on a 24 GB machine; 30m fails safe.
  const helper = freshHelper();
  script = (n) => ({ status: 200, body: n === 1 ? GOOD_CLASSIFICATION : GOOD_SOLUTION });
  await helper.solveImageProblem(fixturePng);
  assert.equal(requests[0].keep_alive, "30m");
});

await check("warm() loads the model with the same num_ctx as a real call, no prompt", async () => {
  // Ollama keys the loaded runner on load-time options; a warm with a different
  // num_ctx forces a second load and costs the 3.7s twice.
  const helper = freshHelper();
  // Call 1 is the warm; the real solve is calls 2 and 3.
  script = (n) => ({
    status: 200,
    body:
      n === 1
        ? JSON.stringify({ done: true, done_reason: "load" })
        : n === 2
          ? GOOD_CLASSIFICATION
          : GOOD_SOLUTION,
  });
  await helper.warm();
  assert.equal(requests.length, 1, "warm must be exactly one request");
  const warm = requests[0];
  assert.ok(!("prompt" in warm) || warm.prompt === "", "warm must not generate");
  assert.equal(warm.keep_alive, "30m");
  await helper.solveImageProblem(fixturePng);
  assert.equal(warm.options.num_ctx, requests[1].options.num_ctx, "load options must match");
  assert.equal(warm.model, requests[1].model);
});

await check("warm() never throws, even with Ollama down", async () => {
  delete require.cache[require.resolve("../dist-electron/LLMHelper.js")];
  const { LLMHelper } = require("../dist-electron/LLMHelper.js");
  const helper = new LLMHelper(undefined, "http://127.0.0.1:1");
  await helper.warm();
});

// --- debug flow: baseline reuse & lifecycle ---------------------------------
//
// ProcessingHelper drives this, and it is loadable from plain node because its
// only reference to AppState is a type. A fake AppState records the events it
// is asked to send, so the whole flow is observable without electron.

function fakeAppState(view) {
  const sent = [];
  const state = {
    view,
    problemInfo: null,
    solutionCode: null,
    hasDebugged: false,
    queue: [],
    extraQueue: [],
    sent,
    PROCESSING_EVENTS: {
      NO_SCREENSHOTS: "processing-no-screenshots",
      INITIAL_START: "initial-start",
      PROBLEM_EXTRACTED: "problem-extracted",
      SOLUTION_SUCCESS: "solution-success",
      INITIAL_SOLUTION_ERROR: "solution-error",
      DEBUG_START: "debug-start",
      DEBUG_SUCCESS: "debug-success",
      DEBUG_ERROR: "debug-error",
    },
    getMainWindow: () => ({
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    }),
    getView: () => state.view,
    setView: (v) => { state.view = v; },
    getScreenshotHelper: () => ({
      getScreenshotQueue: () => state.queue,
      getExtraScreenshotQueue: () => state.extraQueue,
    }),
    getProblemInfo: () => state.problemInfo,
    setProblemInfo: (p) => { state.problemInfo = p; },
    getSolutionCode: () => state.solutionCode,
    setSolutionCode: (c) => { state.solutionCode = c; },
    setHasDebugged: (v) => { state.hasDebugged = v; },
  };
  return state;
}

function freshProcessingHelper(appState) {
  process.env.OLLAMA_URL = stubUrl;
  process.env.OLLAMA_MODEL = "qwen2.5vl:7b";
  delete require.cache[require.resolve("../dist-electron/ProcessingHelper.js")];
  delete require.cache[require.resolve("../dist-electron/LLMHelper.js")];
  const { ProcessingHelper } = require("../dist-electron/ProcessingHelper.js");
  return new ProcessingHelper(appState);
}

const IMPROVED_SOLUTION = JSON.stringify({
  solution: {
    code: "def find_it(seq):\n    return reduce(xor, seq)",
    language: "Python",
    explanation: "handles the empty case",
    thoughts: ["guard empty input"],
    time_complexity: "O(n)",
    space_complexity: "O(1)",
  },
});
const DISPLAYED_CODE = "def find_it(seq):\n    return 5";

await check("a debug run reuses the displayed solution instead of re-solving it", async () => {
  // The old path called generateSolution first: a text-only re-solve (~16s on
  // this machine) whose output the user had never seen, and which then became
  // the "Previous Version" in the diff.
  const appState = fakeAppState("solutions");
  appState.problemInfo = { problem_statement: "Find the odd int", language: "Python" };
  appState.solutionCode = DISPLAYED_CODE;
  appState.extraQueue = [fixturePng];
  const helper = freshProcessingHelper(appState);
  script = (n) => ({ status: 200, body: n === 1 ? "" : IMPROVED_SOLUTION });

  await helper.processScreenshots();

  // Call 1 is the constructor warm-up; exactly one generation must follow it.
  assert.equal(requests.length, 2, `expected warm + 1 debug call, got ${requests.length}`);
  const success = appState.sent.find((e) => e.channel === "debug-success");
  assert.ok(success, `no debug-success sent: ${JSON.stringify(appState.sent.map((e) => e.channel))}`);
  assert.equal(
    success.payload.solution.old_code,
    DISPLAYED_CODE,
    "the diff baseline must be the code the user is looking at"
  );
  assert.equal(success.payload.solution.new_code, "def find_it(seq):\n    return reduce(xor, seq)");
});

await check("a debug run with no cached solution still generates a baseline", async () => {
  // e.g. the app was relaunched between the solve and the debug.
  const appState = fakeAppState("solutions");
  appState.problemInfo = { problem_statement: "Find the odd int", language: "Python" };
  appState.solutionCode = null;
  appState.extraQueue = [fixturePng];
  const helper = freshProcessingHelper(appState);
  script = (n) => ({ status: 200, body: n === 1 ? "" : n === 2 ? GOOD_SOLUTION : IMPROVED_SOLUTION });

  await helper.processScreenshots();

  assert.equal(requests.length, 3, "warm + generateSolution + debug");
  const success = appState.sent.find((e) => e.channel === "debug-success");
  assert.equal(success.payload.solution.old_code, DISPLAYED_CODE);
});

await check("the next debug improves on the fix, not on the original", async () => {
  const appState = fakeAppState("solutions");
  appState.problemInfo = { problem_statement: "Find the odd int", language: "Python" };
  appState.solutionCode = DISPLAYED_CODE;
  appState.extraQueue = [fixturePng];
  const helper = freshProcessingHelper(appState);
  script = (n) => ({ status: 200, body: n === 1 ? "" : IMPROVED_SOLUTION });

  await helper.processScreenshots();

  assert.equal(
    appState.solutionCode,
    "def find_it(seq):\n    return reduce(xor, seq)",
    "the debug output must become the baseline for the following run"
  );
});

await check("a new problem clears the old baseline before solving", async () => {
  // Without this, a debug after a FAILED second solve diffs problem B's
  // statement against problem A's code.
  const appState = fakeAppState("queue");
  appState.solutionCode = "code from the previous problem";
  appState.queue = [fixturePng];
  const helper = freshProcessingHelper(appState);
  script = (n) => ({ status: 200, body: n === 1 ? "" : n === 2 ? GOOD_CLASSIFICATION : GARBAGE_PROSE });

  await helper.processScreenshots();

  assert.ok(
    appState.sent.some((e) => e.channel === "solution-error"),
    "the failed solve must surface an error"
  );
  assert.equal(appState.solutionCode, null, "a failed solve must leave no stale baseline");
});

await check("a successful solve records its code as the debug baseline", async () => {
  const appState = fakeAppState("queue");
  appState.queue = [fixturePng];
  const helper = freshProcessingHelper(appState);
  script = (n) => ({ status: 200, body: n === 1 ? "" : n === 2 ? GOOD_CLASSIFICATION : GOOD_SOLUTION });

  await helper.processScreenshots();

  assert.ok(appState.sent.some((e) => e.channel === "solution-success"));
  assert.equal(appState.solutionCode, DISPLAYED_CODE);
});

await check("a second request mid-run is ignored, not run concurrently", async () => {
  // The first call flips the view to "solutions" synchronously, so a second
  // Cmd+Enter lands in the DEBUG branch while the solve is still in flight.
  // Unguarded, that starts a second generation: two 6.6 GB runs on a 24 GB
  // machine thrash and both finish slower than one would have.
  const appState = fakeAppState("queue");
  appState.queue = [fixturePng];
  appState.extraQueue = [fixturePng];
  const helper = freshProcessingHelper(appState);
  script = (n) => ({
    status: 200,
    body: n === 1 ? "" : n === 2 ? GOOD_CLASSIFICATION : GOOD_SOLUTION,
    delayMs: n >= 2 ? 400 : 0,
  });

  const solving = helper.processScreenshots();
  await new Promise((r) => setTimeout(r, 100));
  await helper.processScreenshots();
  await solving;

  // warm + classification + solution = 3. A concurrent debug would add one more.
  assert.equal(requests.length, 3, `expected 3 calls, got ${requests.length}`);
  assert.equal(
    appState.sent.filter((e) => e.channel === "debug-start").length,
    0,
    "no debug run may start while a solve is in flight"
  );
});

await check("a later request is accepted once the run has finished", async () => {
  // The guard must release, or the app would wedge after its first solve.
  const appState = fakeAppState("queue");
  appState.queue = [fixturePng];
  const helper = freshProcessingHelper(appState);
  script = (n) => ({ status: 200, body: n === 1 ? "" : n === 2 ? GOOD_CLASSIFICATION : GOOD_SOLUTION });

  await helper.processScreenshots();
  appState.extraQueue = [fixturePng];
  script = (n) => ({ status: 200, body: IMPROVED_SOLUTION });
  await helper.processScreenshots();

  assert.equal(appState.sent.filter((e) => e.channel === "debug-start").length, 1);
  assert.ok(appState.sent.some((e) => e.channel === "debug-success"));
});

// --- report -----------------------------------------------------------------

server.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`FAILED: ${f.name}\n${f.error.stack}\n`);
  process.exit(1);
}

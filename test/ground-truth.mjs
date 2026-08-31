/**
 * End-to-end ground-truth test against a REAL Ollama instance.
 *
 *   node test/ground-truth.mjs [model]
 *
 * Drives the compiled LLMHelper over a real Codewars screenshot whose answer is
 * knowable independently, then EXECUTES the generated code and checks the result.
 * Nothing here is eyeballed.
 *
 * Fixture: screenshots/04073c36-...png - Codewars "Find the odd int" (6 kyu).
 *   Language selector reads C# 12.0; stub is Solution.Kata.find_it(int[] seq).
 *   Sample test asserts find_it([20,1,-1,2,-2,3,3,5,5,1,2,4,20,4,-1,-2,5]) == 5.
 *
 * Two independent things are scored:
 *   LANGUAGE  - was C# read off the screenshot? (the hardcoded "C#" is gone, so
 *               this genuinely exercises auto-detection)
 *   CORRECTNESS - does the emitted code compile/run and return 5?
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LLMHelper } = require("../dist-electron/LLMHelper.js");

const SCREENSHOT = "screenshots/04073c36-baaf-4e70-97e1-437f149cdd3b.png";
const SEQ = [20, 1, -1, 2, -2, 3, 3, 5, 5, 1, 2, 4, 20, 4, -1, -2, 5];
const EXPECTED = 5;

const model = process.argv[2] || process.env.OLLAMA_MODEL || undefined;
const url = process.env.OLLAMA_URL || "http://localhost:11434";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ground-truth-"));
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf-8", stdio: "pipe", ...opts });

// --- language-specific execution -------------------------------------------

function runCSharp(code) {
  const proj = path.join(tmp, "gt");
  fs.mkdirSync(proj, { recursive: true });
  const tfm = (process.env.DOTNET_TFM || "net10.0");
  fs.writeFileSync(path.join(proj, "gt.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>` +
    `<OutputType>Exe</OutputType><TargetFramework>${tfm}</TargetFramework>` +
    `<Nullable>disable</Nullable><ImplicitUsings>enable</ImplicitUsings>` +
    `<AssemblyName>gt</AssemblyName><StartupObject>GroundTruthEntry</StartupObject>` +
    `</PropertyGroup></Project>`);
  fs.writeFileSync(path.join(proj, "Solution.cs"), code);

  const seq = `new int[]{${SEQ.join(",")}}`;
  // The prompt tells the model to match the supplied signature, so
  // Solution.Kata.find_it is expected; fall back to a bare Kata.
  const variants = [
    `public static class GroundTruthEntry{public static void Main(){System.Console.WriteLine(Solution.Kata.find_it(${seq}));}}`,
    `public static class GroundTruthEntry{public static void Main(){System.Console.WriteLine(Kata.find_it(${seq}));}}`,
  ];

  let lastError = "";
  for (const [i, main] of variants.entries()) {
    fs.writeFileSync(path.join(proj, "Main.cs"), main);
    try {
      return sh("dotnet", ["run", "--project", proj, "-v", "q", "--nologo"], {
        cwd: proj,
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
      }).trim();
    } catch (error) {
      lastError = (error.stdout || "") + (error.stderr || "");
      if (i === variants.length - 1) throw new Error(lastError.slice(0, 1200));
    }
  }
  throw new Error(lastError.slice(0, 1200));
}

function runPython(code) {
  const file = path.join(tmp, "sol.py");
  fs.writeFileSync(file, `${code}\n\nprint(find_it([${SEQ.join(",")}]))\n`);
  return sh("python3", [file]).trim();
}

function runJavaScript(code) {
  const file = path.join(tmp, "sol.mjs");
  fs.writeFileSync(file, `${code}\n\nconsole.log(find_it([${SEQ.join(",")}]));\n`);
  return sh("node", [file]).trim();
}

function execute(language, code) {
  const l = language.toLowerCase();
  if (l.includes("c#") || l.includes("csharp")) return { runner: "dotnet", output: runCSharp(code) };
  if (l.includes("python")) return { runner: "python3", output: runPython(code) };
  if (l.includes("javascript") || l.includes("typescript") || l.includes("node"))
    return { runner: "node", output: runJavaScript(code) };
  throw new Error(`no runner wired for language "${language}"`);
}

// --- run --------------------------------------------------------------------

console.log(`\nGround-truth run against ${url}${model ? ` (model: ${model})` : " (auto-selected model)"}`);
console.log(`Fixture: ${SCREENSHOT}\n`);

const helper = new LLMHelper(model, url);
const startedAt = Date.now();
let result;
try {
  result = await helper.solveImageProblem(SCREENSHOT);
} catch (error) {
  console.error(`PIPELINE FAILED after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.error(error.message);
  process.exit(1);
}
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

const detected = result.problemInfo.language || "";
const code = result.solution.code || "";

console.log(`Model            : ${helper.getCurrentModel()}`);
console.log(`Elapsed          : ${elapsed}s (both stages)`);
console.log(`Problem type     : ${result.problemInfo.problem_type}`);
console.log(`Detected language: ${detected}`);
console.log(`Problem statement: ${String(result.problemInfo.problem_statement).slice(0, 160)}`);
console.log(`\n--- generated code ---\n${code}\n----------------------\n`);

const languageOk = /c#|csharp/i.test(detected);
console.log(`LANGUAGE    : ${languageOk ? "PASS" : "FAIL"} - screenshot says C#, model said "${detected}"`);

let correctnessOk = false;
let detail = "";
try {
  const { runner, output } = execute(detected, code);
  correctnessOk = output.trim() === String(EXPECTED);
  detail = `${runner} printed "${output.trim()}", expected "${EXPECTED}"`;
} catch (error) {
  detail = `execution failed: ${error.message.split("\n").slice(0, 6).join(" | ")}`;
}
console.log(`CORRECTNESS : ${correctnessOk ? "PASS" : "FAIL"} - ${detail}`);

fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
if (!correctnessOk) process.exit(1);
if (!languageOk) process.exit(2);   // ran correctly, but in the wrong language

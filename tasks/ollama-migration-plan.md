# Plan: Make free-cluely fully functional on local Ollama (no cloud API keys)

Target machine: MacBook Pro, Apple M5 Pro, 15 cores, **24 GB unified memory**, ollama 0.33.2.
Repo: /Users/ltmas/Repo/experiments/demo/AI_Skills/free-cluely, branch `feature/modify_solutions_page_layout`.

## Root-cause claim (the thing to attack)

The app is **not** missing Ollama support. `electron/LLMHelper.ts` already has an Ollama branch in
every method. The claim is that the Ollama path was bolted on as a *text-only mirror* of the Gemini
path, while the app is fundamentally **vision-first** and **strict-JSON-dependent**. Therefore
`USE_OLLAMA=true` today produces garbage or crashes, for four specific structural reasons:

- **R1 — No JSON mode.** `callOllama` (electron/LLMHelper.ts:332-364) posts to `/api/generate` with
  `stream:false` and `options:{temperature,top_p}` but **never sends `format:"json"`**. Every caller
  then runs the result through `safeParseJson`, which on failure returns a *typed fallback object*.
  The UI renders that fallback as if it were a real answer. Silent wrong answers, not errors.
- **R2 — Default model cannot see.** Field default is `llama3.2` (LLMHelper.ts:15); constructor
  default is `gemma:latest` (LLMHelper.ts:28). Neither is a vision model. The app's primary flow is
  screenshot -> `extractProblemFromImages` -> `images:[base64]`. A non-vision model silently ignores
  or rejects the `images` array.
- **R3 — Fire-and-forget init race.** The constructor calls `this.initializeOllamaModel()` at
  LLMHelper.ts:32 **without `await`** (constructors cannot await). Any request issued before that
  promise resolves uses the stale/wrong `this.ollamaModel`. There is no readiness gate.
- **R4 — Blind model auto-select.** `initializeOllamaModel` falls back to `availableModels[0]`
  (LLMHelper.ts:386). The local `ollama list` contains **four embedding-only models**
  (nomic-embed-text, bge-m3, embeddinggemma, mxbai-embed-large). If `/api/tags` returns one first,
  the app silently binds to a model that cannot generate at all.

## Phase 0 — Evidence baseline (IN FLIGHT, 3 parallel agents)
- `build-audit`: `tsc --noEmit` (both tsconfigs) + `npm run build`, catalogue every defect, check
  whether `.env` (which holds a real `GEMINI_API_KEY`) is git-tracked, check `dist-electron/` staleness.
- `ollama-bench`: empirically rank the already-pulled models on (a) vision extraction from a real
  interview screenshot, (b) coding-problem correctness with executed code, (c) strict-JSON adherence.
  Must report which models emit `<think>` / harmony-channel tokens that break `JSON.parse`.
- `ollama-code-audit`: exhaustive read-only catalogue of every Ollama-vs-Gemini divergence, IPC
  wiring gaps, and every silent-fallback-rendered-as-answer path.

**Gate:** no code is written until all three report. Plan is revised against their findings.

## Phase 1 — Fix the Ollama transport (electron/LLMHelper.ts)
1. `callOllama(prompt, images?, opts?)`: add `format:"json"` for the JSON call sites only (the chat/
   text call sites must stay free-form), add `options.num_ctx` sized to the screenshot prompt, add
   `keep_alive`, and add an `AbortController` timeout (local 14B+ models on 24 GB can take minutes;
   an unbounded fetch hangs the UI forever with no error).
2. Strip reasoning-block prefixes (`<think>...</think>` and any harmony channel markers) **before**
   `cleanJsonResponse`, gated on what `ollama-bench` actually observes.
3. Replace the `availableModels[0]` fallback with a **generation-capable filter** — query
   `/api/show` per model (or filter on a known embedding-model denylist) so an embedding model can
   never be selected.
4. Replace the fire-and-forget constructor init with an explicit `ready: Promise<void>` that every
   public method awaits. Constructor stays sync; readiness is awaited at the call boundary.
5. Split the model into **two roles**: `visionModel` (image extraction) and `textModel` (solution
   generation), each independently configurable. Default both from `ollama-bench`'s recommendation.

## Phase 2 — Make Ollama the default, remove the cloud requirement
6. `electron/ProcessingHelper.ts:20-37`: invert the default — Ollama unless `GEMINI_API_KEY` is
   explicitly set AND `USE_OLLAMA` is not `true`. Delete the hard `throw` on missing key.
7. `.env` / `.env.example`: default to `USE_OLLAMA=true` with the benchmarked model names.
   **Remove the live `GEMINI_API_KEY` value from `.env`** and confirm `.env` is git-ignored/untracked.
8. Preflight: if Ollama is unreachable at `${OLLAMA_URL}/api/tags`, surface a real user-visible error
   in the UI ("Ollama not running") instead of the current silent fallback object.

## Phase 3 — UI truthfulness
9. `src/components/ui/ModelSelector.tsx` must list the actual local models and persist the choice
   through the existing `switchToOllama` IPC. Remove/disable any Gemini-model UI strings that no
   longer apply (Queue.tsx currently advertises a Gemini model name).
10. Audio features that the Ollama branch degrades to "text prompt only" must either be wired to a
    real local transcription path or be **visibly disabled** — not silently degraded.

## Phase 4 — Verification (no claim without an artifact)
11. `npx tsc --noEmit` on both tsconfigs — paste output.
12. Launch the real app (`npm run app:dev`), capture a real interview-question screenshot through the
    app's own hotkey, and confirm end-to-end: extraction -> solution -> rendered in Solutions.tsx.
    Paste the console log and a screenshot of the rendered result.
13. Mutation check: point `OLLAMA_URL` at a dead port and confirm the UI shows an ERROR, not a
    plausible-looking fallback answer.

## Explicit non-goals
- No new dependencies (the `ollama` npm package is not needed; `fetch` is already used).
- No refactor of the Gemini path beyond making it optional — it stays as a fallback.
- No changes to WindowHelper/ScreenshotHelper/shortcuts.

## Known risk to be attacked
On 24 GB unified memory, holding a **vision model and a text model resident simultaneously** may
cause Ollama to evict and reload between every request, turning a 10 s answer into a 60 s answer.
The two-model split (step 5) may therefore be the wrong architecture.

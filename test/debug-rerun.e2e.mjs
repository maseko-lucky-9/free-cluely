/**
 * End-to-end test for the reported bug: a repeat debug run showed
 * "Loading code comparison..." and then redisplayed the PREVIOUS run's diff.
 *
 *   node_modules/.bin/electron test/debug-rerun.e2e.mjs
 *
 * Real main process, real renderer, real Ollama, real DOM assertions. Nothing
 * is eyeballed and nothing is stubbed.
 *
 * Why not drive the hotkeys instead: sending keystrokes needs an Accessibility
 * grant for the *terminal*, which is a different TCC entry from the app's own.
 * This drives the same code path one level in, which also lets it read the DOM.
 *
 * Mutation-check it: make Debug.tsx apply its payload only on mount (the
 * original defect) and DEBUG 2 goes red on "old_code advanced".
 */
import { app, BrowserWindow, nativeImage } from "electron"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Fixtures: three different problem screenshots so each debug run has new input.
const FIXTURES = [
  "screenshots/04073c36-baaf-4e70-97e1-437f149cdd3b.png",
  "screenshots/033501a0-fa0c-4fa7-97e2-daa5c9921431.png",
  "screenshots/04926d8d-b324-4309-a1de-37720c16d3a1.png",
].map((p) => path.join(root, p))

const failures = []
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(`${name} ${detail}`)
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}

/** Importing main.js boots the real app: window, IPC handlers, shortcuts. */
const { AppState } = require(path.join(root, "dist-electron/main.js"))

const waitFor = async (label, predicate, timeoutMs = 300_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const bodyText = async (win) =>
  win.webContents.executeJavaScript("document.body.innerText")

/** Copies a fixture into the queue the given view reads from. */
function enqueue(appState, view, fixture) {
  const helper = appState.getScreenshotHelper()
  const dir = path.join(
    app.getPath("userData"),
    view === "queue" ? "screenshots" : "extra_screenshots",
  )
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `e2e-${view}-${Date.now()}.png`)
  fs.copyFileSync(fixture, dest)
  // getScreenshotQueue returns the live array.
  const queue =
    view === "queue" ? helper.getScreenshotQueue() : helper.getExtraScreenshotQueue()
  queue.push(dest)
  return dest
}

async function run() {
  // main.js creates the window in its own whenReady handler; wait for it.
  await waitFor("main window", () => BrowserWindow.getAllWindows().length > 0, 30_000)
  const appState = AppState.getInstance()
  const win = appState.getMainWindow()
  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve()
    win.webContents.once("did-finish-load", resolve)
  })
  await waitFor("renderer mounted", async () => (await bodyText(win)).length > 0, 30_000)

  // --- solve ------------------------------------------------------------------

  enqueue(appState, "queue", FIXTURES[0])
  appState.setView("queue")
  await appState.processingHelper.processScreenshots()
  await waitFor("solution rendered", async () => {
    const text = await bodyText(win)
    return text.includes("Solution") && !text.includes("Generating solutions...")
  })
  check("a solve renders a solution", true)
  const solvedCode = appState.getSolutionCode()
  check("the solve records a debug baseline", !!solvedCode, `got ${JSON.stringify(solvedCode)?.slice(0, 40)}`)

  // --- debug 1 ----------------------------------------------------------------

  enqueue(appState, "solutions", FIXTURES[1])
  appState.setView("solutions")
  await appState.processingHelper.processScreenshots()
  await waitFor("debug 1 painted", async () => {
    const text = await bodyText(win)
    return text.includes("Code Comparison") && !text.includes("Loading code comparison")
  })
  const afterDebug1 = await bodyText(win)
  const baselineAfter1 = appState.getSolutionCode()
  check("debug 1 clears the loading state", !afterDebug1.includes("Loading code comparison"))
  check("debug 1 renders both diff panes", afterDebug1.includes("Previous Version") && afterDebug1.includes("New Version"))
  check("debug 1 keeps a baseline for the next run", !!baselineAfter1)

  // --- debug 2: the reported bug ----------------------------------------------

  enqueue(appState, "solutions", FIXTURES[2])
  await appState.processingHelper.processScreenshots()
  await waitFor("debug 2 painted", async () => {
    const text = await bodyText(win)
    return text.includes("Code Comparison") && !text.includes("Loading code comparison")
  })
  const afterDebug2 = await bodyText(win)
  check("debug 2 clears the loading state", !afterDebug2.includes("Loading code comparison"),
    "this is the reported symptom: it used to stay on screen for ever")
  check("debug 2 renders both diff panes", afterDebug2.includes("Previous Version") && afterDebug2.includes("New Version"))
  check("debug 2 shows NEW content, not the previous run's diff", afterDebug2 !== afterDebug1,
    "the mount-only payload read made the view stale here")
  // The chain that matters, and it holds whether or not the model changed the
  // code: the diff baseline is the version the user was just shown.
  const firstRealLine = (code) =>
    (code || "").split("\n").find((l) => l.trim().length > 8) || "\u0000"
  check(
    "debug 2 diffs against the code shown after debug 1",
    afterDebug2.includes(firstRealLine(baselineAfter1)),
    `looked for ${JSON.stringify(firstRealLine(baselineAfter1))}`
  )
  check("debug 2 keeps a baseline for the next run", !!appState.getSolutionCode())

  // --- capture downscale ------------------------------------------------------
  // A real 2x Retina capture of a real problem. The resize lives inside
  // captureTo, which needs a screen-recording grant this process does not have,
  // so the sizing step is driven directly.
  const retina = path.join(
    app.getPath("userData"),
    "screenshots/8e030629-ee11-436b-945c-8bfd3f0dfbc5.png"
  )
  if (fs.existsSync(retina)) {
    const copy = path.join(app.getPath("userData"), `screenshots/e2e-retina-${Date.now()}.png`)
    fs.copyFileSync(retina, copy)
    const before = nativeImage.createFromPath(copy).getSize()
    await appState.getScreenshotHelper()["fitToLogicalSize"](copy)
    const after = nativeImage.createFromPath(copy).getSize()
    check(
      "a real Retina capture is downscaled to its logical width",
      before.width === 3024 && after.width === 1512,
      `${before.width}x${before.height} -> ${after.width}x${after.height}`
    )
    check("the downscaled capture is still a readable image", after.height === 982)
    fs.unlinkSync(copy)
  } else {
    console.log("  SKIP  Retina downscale (no real capture on this machine)")
  }

  // --- report -----------------------------------------------------------------

  console.log(`\n${failures.length ? "FAILED" : "OK"}: ${failures.length} failure(s)`)
  for (const f of failures) console.error(`  ${f}`)
  app.exit(failures.length ? 1 : 0)
}

// NOT a top-level await: that would block module evaluation, and Electron
// does not emit "ready" until the ESM main module has finished evaluating.
app.whenReady().then(run).catch((error) => {
  console.error(`\nHARNESS ERROR: ${error?.stack || error}`)
  app.exit(1)
})

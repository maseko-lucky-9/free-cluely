// Screen-capture failure messages. No electron import - keep it that way so
// this stays unit-testable from plain node.

/**
 * Product name. Matches build.productName in package.json so the running app,
 * the packaged app, and these messages all agree on one identity.
 */
export const APP_NAME = "Meeting Notes Coder"

/** Bundle id of the stock Electron used when running from source. */
export const DEV_BUNDLE_ID = "com.github.Electron"

/** Mirrors Electron's systemPreferences.getMediaAccessStatus return values. */
export type MediaAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown"

export interface ScreenshotFailureContext {
  /** app.getName() - what the running process calls itself. */
  appName?: string
  /** app.getPath("exe") - the binary macOS attributes the request to. */
  exePath?: string
  /** app.isPackaged - dev runs inside a generic Electron bundle. */
  isPackaged?: boolean
  /** Bundle id TCC keys the decision on. */
  bundleId?: string
  platform?: NodeJS.Platform
}

const PERMISSION_DENIED =
  /could not create image from display|not authorized|screen recording|kCGErrorFailure/i

const SETTINGS_PATH = "System Settings > Privacy & Security > Screen Recording"

/**
 * Explains a screen-capture permission state.
 *
 * The important case is "denied". macOS never re-prompts once denied, and an
 * unpackaged run is attributed to the stock Electron bundle
 * (com.github.Electron), which is ad-hoc signed - so its signature changes on
 * every reinstall and orphans the TCC record. The result is a standing denial
 * with NO entry in the settings pane to toggle. Telling the user to "enable the
 * Electron entry" is useless when no such row exists; the record has to be reset
 * first so the app can ask again.
 */
export function describeScreenCapturePermission(
  status: MediaAccessStatus,
  context: ScreenshotFailureContext = {},
): string {
  const name = context.appName || APP_NAME
  const restart = "Then quit and reopen the app - macOS does not apply a grant to a running process."

  if (context.isPackaged) {
    if (status === "denied" || status === "restricted") {
      return (
        `Screen Recording permission was denied for "${name}". macOS will not ask again, ` +
        `so enable it manually: ${SETTINGS_PATH}. ${restart}`
      )
    }
    return (
      `Screen Recording permission is required. Approve the prompt, or enable "${name}" ` +
      `under ${SETTINGS_PATH}. ${restart}`
    )
  }

  const bundleId = context.bundleId || DEV_BUNDLE_ID
  const where = context.exePath ? `\nBinary: ${context.exePath}` : ""

  if (status === "denied" || status === "restricted") {
    return (
      `Screen Recording is DENIED for the Electron bundle this app runs from, and macOS never ` +
      `re-asks once denied. Because the development build is ad-hoc signed, the entry is often ` +
      `missing from ${SETTINGS_PATH} entirely - so there may be nothing there to switch on.\n` +
      `Reset the stale decision, then relaunch and trigger a capture to get a fresh prompt:\n` +
      `    tccutil reset ScreenCapture ${bundleId}\n` +
      `If a prompt still does not appear, add the binary manually with the "+" button in ` +
      `${SETTINGS_PATH} (press Cmd+Shift+G in the file picker to paste a path).${where}\n` +
      `A packaged build (npm run app:build) gets its own entry named "${name}" and avoids this.`
    )
  }

  return (
    `Screen Recording permission is required. Trigger a capture and approve the macOS prompt. ` +
    `The prompt will name "Electron", not "${name}", because the app is running from source.${where}`
  )
}

/**
 * macOS refuses screen capture without Screen Recording permission, and
 * `screencapture` reports it as "could not create image from display" - which
 * tells the user nothing.
 */
export function describeScreenshotFailure(
  raw: string,
  context: ScreenshotFailureContext = {},
): string {
  const platform = context.platform ?? process.platform
  if (!PERMISSION_DENIED.test(raw)) {
    return `Failed to take screenshot: ${raw}`
  }
  if (platform !== "darwin") {
    return (
      `Screen capture was blocked by the operating system. ` +
      `Check screen-capture permissions for ${context.appName || APP_NAME}.`
    )
  }
  return describeScreenCapturePermission("denied", context)
}

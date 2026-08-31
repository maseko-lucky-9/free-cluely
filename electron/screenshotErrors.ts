// Screen-capture failure messages. No electron import - keep it that way so
// this stays unit-testable from plain node.

/**
 * Product name. Matches build.productName in package.json so the running app,
 * the packaged app, and these messages all agree on one identity.
 */
export const APP_NAME = "Meeting Notes Coder"

/**
 * macOS 26 renamed this pane. Older docs (and earlier versions of this file)
 * say "Screen Recording", which no longer matches what the user sees.
 */
export const SETTINGS_PATH =
  "System Settings > Privacy & Security > Screen & System Audio Recording"

/** Mirrors Electron's systemPreferences.getMediaAccessStatus return values. */
export type MediaAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown"

export interface ScreenshotFailureContext {
  /** app.getName() - what the running process calls itself. */
  appName?: string
  /** app.getPath("exe") - the binary being run. */
  exePath?: string
  /** app.isPackaged - false when running from source. */
  isPackaged?: boolean
  /**
   * True when this process was started by a shell/terminal rather than by
   * Finder, the Dock or `open`. Decided by process.ppid !== 1.
   */
  launchedFromShell?: boolean
  /** Best-effort name of the process macOS holds responsible. */
  responsibleHint?: string
  platform?: NodeJS.Platform
}

/**
 * Finder/Dock/`open` launches are reparented to launchd (ppid 1), so the app is
 * responsible for itself. Any other parent means a shell started it, and macOS
 * attributes screen capture to the app owning that shell instead.
 */
export function isLaunchedFromShell(ppid: number): boolean {
  return ppid !== 1
}

/**
 * screenshot-desktop sanitises the output path with
 *   filename.replace(/[^a-zA-Z0-9._\-/]/g, "")
 * so ANY space is silently deleted and the capture is redirected to a directory
 * that does not exist - while still resolving successfully. macOS userData lives
 * under "Application Support", which always contains a space, so the destination
 * can never be passed to it directly.
 */
export function survivesCaptureSanitizer(filePath: string): boolean {
  return filePath === filePath.replace(/[^a-zA-Z0-9._\-/]/g, "")
}

const PERMISSION_DENIED =
  /could not create image from display|not authorized|screen recording|kCGErrorFailure/i

const RESTART =
  "Then quit and reopen the app - macOS does not apply a grant to an already-running process."

/**
 * Explains a screen-capture permission state.
 *
 * The decisive fact is NOT the app's name or bundle id - it is which process
 * macOS holds RESPONSIBLE. When a process is started from a shell, TCC attributes
 * screen capture to the app that owns that shell (Terminal, iTerm, VS Code,
 * Claude...), not to this app. So a shell-launched run consults some other
 * entry's permission entirely, and toggling this app's own entry changes nothing.
 * Only a Finder/Dock/`open` launch makes the app responsible for itself.
 *
 * Earlier versions of this message blamed a stale com.github.Electron record and
 * recommended `tccutil reset`. That diagnosis came from probes that were
 * themselves shell-launched, so they were reading the launching app's status
 * rather than this app's - measuring the wrong subject entirely.
 */
export function describeScreenCapturePermission(
  status: MediaAccessStatus,
  context: ScreenshotFailureContext = {},
): string {
  const name = context.appName || APP_NAME
  const where = context.exePath ? `\nBinary: ${context.exePath}` : ""

  if (context.launchedFromShell) {
    const responsible = context.responsibleHint
      ? `the app that owns that shell (${context.responsibleHint})`
      : "the app that owns that shell (your terminal, editor, or whatever ran the command)"
    return (
      `Screen capture is unavailable because this process was started from a shell. macOS ` +
      `attributes screen capture to ${responsible}, NOT to "${name}" - so the entry for ` +
      `"${name}" under ${SETTINGS_PATH} does not govern this run, and switching it on will ` +
      `not help.\n` +
      `Quit this instance and launch the packaged app from Finder (or: open -a "${name}"). ` +
      `Only then is "${name}" responsible for itself and its own permission entry applies.` +
      where
    )
  }

  if (status === "denied" || status === "restricted") {
    return (
      `Screen capture is denied for "${name}". Open ${SETTINGS_PATH} and switch "${name}" ON. ` +
      `If it is already ON, the grant predates the app's current signature: switch it OFF and ` +
      `back ON to refresh it. ${RESTART}` +
      where
    )
  }

  return (
    `Screen capture permission has not been granted yet. Trigger a capture and approve the macOS ` +
    `prompt, or switch "${name}" ON under ${SETTINGS_PATH}. ${RESTART}` +
    where
  )
}

/**
 * macOS refuses screen capture without permission, and `screencapture` reports
 * it as "could not create image from display" - which tells the user nothing.
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

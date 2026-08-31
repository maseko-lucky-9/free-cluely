// Screen-capture failure messages. No electron import - keep it that way so
// this stays unit-testable from plain node.

/**
 * Product name. Matches build.productName in package.json so the running app,
 * the packaged app, and these messages all agree on one identity.
 */
export const APP_NAME = "Meeting Notes Coder"

export interface ScreenshotFailureContext {
  /** app.getName() - what the running process calls itself. */
  appName?: string
  /** app.getPath("exe") - the binary macOS actually attributes the request to. */
  exePath?: string
  /** app.isPackaged - dev runs inside a generic Electron bundle. */
  isPackaged?: boolean
  platform?: NodeJS.Platform
}

const PERMISSION_DENIED =
  /could not create image from display|not authorized|screen recording|kCGErrorFailure/i

/**
 * macOS refuses screen capture without Screen Recording permission, and
 * `screencapture` reports it as "could not create image from display" - which
 * tells the user nothing.
 *
 * Naming the app is not enough on its own. macOS attributes the request to the
 * BUNDLE, not to app.setName(), so an unpackaged run is listed under the generic
 * Electron bundle (CFBundleName "Electron", com.github.Electron) that every
 * Electron dev app shares. Telling the user to "enable this app" is therefore
 * unactionable when they have Claude, Cursor, VS Code and others installed. Say
 * which entry to look for and why it does not carry the product name.
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

  const name = context.appName || APP_NAME
  const restart = "then quit and reopen it - macOS does not apply the grant to a running process."

  if (context.isPackaged) {
    return (
      `Screen Recording permission denied for "${name}". ` +
      `Open System Settings > Privacy & Security > Screen Recording, enable "${name}", ` +
      restart
    )
  }

  const where = context.exePath ? `\nThe binary requesting it is: ${context.exePath}` : ""
  return (
    `Screen Recording permission denied. Running from source, so macOS attributes this to the ` +
    `generic Electron bundle: in System Settings > Privacy & Security > Screen Recording look for ` +
    `"Electron", NOT "${name}". That entry is shared by every Electron app run from source, so ` +
    `enabling it also covers them. Enable it, ${restart}` +
    where +
    `\nFor an entry under its own name instead, build the app (npm run app:build) and run that.`
  )
}

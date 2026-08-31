// Screen-capture failure messages. No electron import - keep it that way so
// this stays unit-testable from plain node.

/**
 * macOS refuses screen capture without Screen Recording permission, and
 * `screencapture` reports it as "could not create image from display" - which
 * tells the user nothing. Translate it into the actual fix.
 */
export function describeScreenshotFailure(raw: string): string {
  const permissionDenied =
    /could not create image from display|not authorized|screen recording|kCGErrorFailure/i.test(raw)

  if (permissionDenied && process.platform === "darwin") {
    return (
      "Screen Recording permission denied. Grant it in System Settings > Privacy & " +
      "Security > Screen Recording, enable this app, then restart it - macOS does " +
      "not apply the grant to an already-running process."
    )
  }
  if (permissionDenied) {
    return "Screen capture was blocked by the operating system. Check this app's screen-capture permissions."
  }
  return `Failed to take screenshot: ${raw}`
}

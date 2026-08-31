// File logging for the packaged app.
//
// A Finder-launched app has no visible stdout, so console.log is invisible
// exactly when something goes wrong in a real install. Everything worth
// diagnosing goes to userData/app.log instead.

import { app } from "electron";
import fs from "fs";
import path from "path";

export function logEvent(line: string): void {
  const stamped = `${new Date().toISOString()}  ${line}`;
  console.log(stamped);
  try {
    fs.appendFileSync(
      path.join(app.getPath("userData"), "app.log"),
      `${stamped}\n`,
    );
  } catch {
    // Diagnostics must never break the feature they are diagnosing.
  }
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

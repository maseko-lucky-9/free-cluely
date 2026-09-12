// File logging for the packaged app.
//
// A Finder-launched app has no visible stdout, so console.log is invisible
// exactly when something goes wrong in a real install. Everything worth
// diagnosing goes to userData/app.log instead.
//
// Every line carries the pid: two instances of this app are invisible (no dock
// icon, no taskbar entry) and share this file, and without the pid a line from
// the instance that does NOT own the global shortcuts is indistinguishable from
// one that does.

import { app } from "electron";
import fs from "fs";
import path from "path";

export function logEvent(line: string): void {
  const stamped = `${new Date().toISOString()}  [${process.pid}] ${line}`;
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

/** One line per launch so a log can be attributed to a build and a bundle. */
export function logStartup(): void {
  logEvent(
    `startup version=${app.getVersion()} packaged=${app.isPackaged} ` +
      `electron=${process.versions.electron} exe=${app.getPath("exe")}`,
  );
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

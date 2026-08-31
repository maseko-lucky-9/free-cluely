// ScreenshotHelper.ts

import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { app, systemPreferences, desktopCapturer } from "electron"
import { v4 as uuidv4 } from "uuid"
import screenshot from "screenshot-desktop"
import {
  describeScreenshotFailure,
  describeScreenCapturePermission,
  isLaunchedFromShell,
  survivesCaptureSanitizer,
  MediaAccessStatus
} from "./screenshotErrors"

export class ScreenshotHelper {
  private screenshotQueue: string[] = []
  private extraScreenshotQueue: string[] = []
  private readonly MAX_SCREENSHOTS = 5

  private readonly screenshotDir: string
  private readonly extraScreenshotDir: string

  private view: "queue" | "solutions" = "queue"

  constructor(view: "queue" | "solutions" = "queue") {
    this.view = view

    // Initialize directories
    this.screenshotDir = path.join(app.getPath("userData"), "screenshots")
    this.extraScreenshotDir = path.join(
      app.getPath("userData"),
      "extra_screenshots"
    )

    // Create directories if they don't exist
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir)
    }
    if (!fs.existsSync(this.extraScreenshotDir)) {
      fs.mkdirSync(this.extraScreenshotDir)
    }
  }

  public getView(): "queue" | "solutions" {
    return this.view
  }

  public setView(view: "queue" | "solutions"): void {
    this.view = view
  }

  public getScreenshotQueue(): string[] {
    return this.screenshotQueue
  }

  public getExtraScreenshotQueue(): string[] {
    return this.extraScreenshotQueue
  }

  public clearQueues(): void {
    // Clear screenshotQueue
    this.screenshotQueue.forEach((screenshotPath) => {
      fs.unlink(screenshotPath, (err) => {
        if (err)
          console.error(`Error deleting screenshot at ${screenshotPath}:`, err)
      })
    })
    this.screenshotQueue = []

    // Clear extraScreenshotQueue
    this.extraScreenshotQueue.forEach((screenshotPath) => {
      fs.unlink(screenshotPath, (err) => {
        if (err)
          console.error(
            `Error deleting extra screenshot at ${screenshotPath}:`,
            err
          )
      })
    })
    this.extraScreenshotQueue = []
  }

  /**
   * Captures to a sanitiser-safe staging path, verifies an image was actually
   * produced, then moves it to the destination.
   *
   * Two defects are handled here. screenshot-desktop strips spaces from the
   * output path (see survivesCaptureSanitizer), and when a filename is supplied
   * it resolves WITHOUT checking that the file was written - so a failed capture
   * looked identical to a successful one.
   */
  private async captureTo(destPath: string): Promise<void> {
    const staging = path.join(os.tmpdir(), `${uuidv4()}.png`)
    if (!survivesCaptureSanitizer(staging)) {
      throw new Error(
        `Cannot capture: the temporary path contains characters the capture tool strips (${staging}).`
      )
    }

    this.logPermission(`capture start staging=${staging} dest=${destPath}`)
    await screenshot({ filename: staging })

    const wrote = fs.existsSync(staging) ? fs.statSync(staging).size : 0
    this.logPermission(`capture staged bytes=${wrote}`)
    if (wrote === 0) {
      throw new Error(
        "Screen capture produced no image. The capture tool reported success but wrote nothing."
      )
    }

    try {
      await fs.promises.rename(staging, destPath)
    } catch {
      // rename fails across volumes; fall back to copy + remove.
      await fs.promises.copyFile(staging, destPath)
      await fs.promises.unlink(staging).catch(() => {})
    }
    this.logPermission(`capture done bytes=${fs.statSync(destPath).size} path=${destPath}`)
  }

  public async takeScreenshot(
    hideMainWindow: () => void,
    showMainWindow: () => void
  ): Promise<string> {
    try {
      hideMainWindow()
      
      // Add a small delay to ensure window is hidden
      await this.ensureScreenCapturePermission()
      await new Promise(resolve => setTimeout(resolve, 100))
      
      let screenshotPath = ""

      if (this.view === "queue") {
        screenshotPath = path.join(this.screenshotDir, `${uuidv4()}.png`)
        await this.captureTo(screenshotPath)

        this.screenshotQueue.push(screenshotPath)
        if (this.screenshotQueue.length > this.MAX_SCREENSHOTS) {
          const removedPath = this.screenshotQueue.shift()
          if (removedPath) {
            try {
              await fs.promises.unlink(removedPath)
            } catch (error) {
              console.error("Error removing old screenshot:", error)
            }
          }
        }
      } else {
        screenshotPath = path.join(this.extraScreenshotDir, `${uuidv4()}.png`)
        await this.captureTo(screenshotPath)

        this.extraScreenshotQueue.push(screenshotPath)
        if (this.extraScreenshotQueue.length > this.MAX_SCREENSHOTS) {
          const removedPath = this.extraScreenshotQueue.shift()
          if (removedPath) {
            try {
              await fs.promises.unlink(removedPath)
            } catch (error) {
              console.error("Error removing old screenshot:", error)
            }
          }
        }
      }

      return screenshotPath
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      console.error("Error taking screenshot:", raw)
      this.logPermission(`capture FAILED raw=${raw.replace(/\s+/g, " ").slice(0, 500)}`)
      throw new Error(
        describeScreenshotFailure(raw, {
          appName: app.getName(),
          exePath: app.getPath("exe"),
          isPackaged: app.isPackaged,
          launchedFromShell: this.launchedFromShell()
        })
      )
    } finally {
      // Ensure window is always shown again
      showMainWindow()
    }
  }


  /**
   * Fails fast with an actionable message instead of shelling out to
   * `screencapture` and surfacing "could not create image from display".
   *
   * When the status is not-determined we call desktopCapturer once: that is the
   * API that actually registers the app with TCC and raises the OS prompt.
   * Spawning the screencapture CLI does not reliably do so, which is why no
   * entry appears in the settings pane for an unpackaged build.
   */
  /**
   * Finder/Dock/`open` launches are reparented to launchd, so ppid === 1 means
   * this app is responsible for itself. Anything else was started by a shell,
   * and macOS attributes screen capture to the app owning that shell instead.
   */
  private launchedFromShell(): boolean {
    return isLaunchedFromShell(process.ppid)
  }

  /**
   * Finder-launched runs have no visible stdout, which is why a correctly
   * attributed failure was previously impossible to diagnose. Append to a file
   * inside userData instead.
   */
  private logPermission(line: string): void {
    try {
      const logPath = path.join(app.getPath("userData"), "permission.log")
      fs.appendFileSync(logPath, `${new Date().toISOString()}  ${line}\n`)
    } catch {
      // Diagnostics must never break capture.
    }
  }

  private async ensureScreenCapturePermission(): Promise<void> {
    if (process.platform !== "darwin") return

    const fromShell = this.launchedFromShell()
    const context = {
      appName: app.getName(),
      exePath: app.getPath("exe"),
      isPackaged: app.isPackaged,
      launchedFromShell: fromShell
    }

    let status = systemPreferences.getMediaAccessStatus("screen") as MediaAccessStatus
    this.logPermission(
      `preflight status=${status} packaged=${app.isPackaged} ppid=${process.ppid} fromShell=${fromShell}`
    )

    // Attempt registration whenever we are not already granted - NOT only when
    // the status is not-determined. macOS lists an app under Screen Recording
    // once it actually attempts a capture, so short-circuiting on "denied" means
    // the entry never appears and there is nothing for the user to switch on.
    if (status !== "granted") {
      try {
        await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1, height: 1 }
        })
        this.logPermission("desktopCapturer.getSources resolved")
      } catch (error) {
        this.logPermission(
          `desktopCapturer.getSources threw: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      status = systemPreferences.getMediaAccessStatus("screen") as MediaAccessStatus
      this.logPermission(`status after registration attempt=${status}`)
    }

    if (status !== "granted") {
      throw new Error(describeScreenCapturePermission(status, context))
    }
  }

  public async getImagePreview(filepath: string): Promise<string> {
    try {
      const data = await fs.promises.readFile(filepath)
      return `data:image/png;base64,${data.toString("base64")}`
    } catch (error) {
      console.error("Error reading image:", error)
      throw error
    }
  }

  public async deleteScreenshot(
    path: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await fs.promises.unlink(path)
      if (this.view === "queue") {
        this.screenshotQueue = this.screenshotQueue.filter(
          (filePath) => filePath !== path
        )
      } else {
        this.extraScreenshotQueue = this.extraScreenshotQueue.filter(
          (filePath) => filePath !== path
        )
      }
      return { success: true }
    } catch (error) {
      console.error("Error deleting file:", error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

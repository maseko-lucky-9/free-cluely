// Persisted LLM selection.
//
// The model chosen in the UI used to live only in memory, so every relaunch
// reverted to the environment default and the user reconfigured by hand.

import { app } from "electron";
import fs from "fs";
import path from "path";

export interface StoredLlmConfig {
  model?: string;
  url?: string;
}

function configPath(): string {
  return path.join(app.getPath("userData"), "llm-config.json");
}

export function loadLlmConfig(): StoredLlmConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        model: typeof parsed.model === "string" ? parsed.model : undefined,
        url: typeof parsed.url === "string" ? parsed.url : undefined,
      };
    }
  } catch {
    // Missing or unreadable file is normal on first run.
  }
  return {};
}

export function saveLlmConfig(config: StoredLlmConfig): void {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
  } catch (error) {
    console.error("[llmConfig] Could not persist model selection:", error);
  }
}

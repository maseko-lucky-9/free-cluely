// ProcessingHelper.ts

import { AppState } from "./main"
import { LLMHelper } from "./LLMHelper"
import dotenv from "dotenv"

dotenv.config()

export class ProcessingHelper {
  private appState: AppState
  private llmHelper: LLMHelper
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null

  constructor(appState: AppState) {
    this.appState = appState

    // Local-only: Ollama is the sole provider. No API key, no cloud fallback.
    const ollamaModel = process.env.OLLAMA_MODEL || undefined
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434"

    console.log("[ProcessingHelper] Initializing with Ollama")
    this.llmHelper = new LLMHelper(ollamaModel, ollamaUrl)
  }

  public async processScreenshots(): Promise<void> {
    const mainWindow = this.appState.getMainWindow()
    if (!mainWindow) return

    const view = this.appState.getView()

    if (view === "queue") {
      const screenshotQueue = this.appState.getScreenshotHelper().getScreenshotQueue()
      if (screenshotQueue.length === 0) {
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
        return
      }

      const allPaths = this.appState.getScreenshotHelper().getScreenshotQueue();
      const lastPath = allPaths[allPaths.length - 1];

      // Audio is unsupported locally. LLMHelper throws rather than inventing a
      // transcript, so surface that as a real error instead of a fake result.
      if (lastPath.endsWith('.mp3') || lastPath.endsWith('.wav')) {
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          "Audio analysis is not available in local mode.");
        return;
      }

      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_START)
      this.appState.setView("solutions")
      this.currentProcessingAbortController = new AbortController()

      try {
        console.log("[ProcessingHelper] Solving problem from image:", lastPath);
        const result = await this.llmHelper.solveImageProblem(
          lastPath,
          this.currentProcessingAbortController.signal
        );

        const problemInfo = {
          problem_statement: result.problemInfo.problem_statement,
          problem_type: result.problemInfo.problem_type,
          language: result.problemInfo.language,
          input_format: result.problemInfo.input_format,
          output_format: result.problemInfo.output_format,
          complexity: result.problemInfo.complexity,
          test_cases: result.problemInfo.test_cases || [] as any[],
          validation_type: result.problemInfo.validation_type,
          difficulty: result.problemInfo.difficulty
        };

        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.PROBLEM_EXTRACTED, problemInfo);
        this.appState.setProblemInfo(problemInfo);

        // solveImageProblem throws unless a usable solution was parsed, so this
        // is always a real answer — never a fabricated placeholder.
        const solutionPayload = {
          solution: {
            code: result.solution.code,
            language: result.solution.language,
            thoughts: result.solution.thoughts || [],
            time_complexity: result.solution.time_complexity || result.problemInfo.complexity?.time || "N/A",
            space_complexity: result.solution.space_complexity || result.problemInfo.complexity?.space || "N/A",
            explanation: result.solution.explanation || ""
          }
        };
        console.log("[ProcessingHelper] Sending solution for language:", result.solution.language);
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.SOLUTION_SUCCESS, solutionPayload);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        console.error("Image problem-solving error:", message)
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, message)
      } finally {
        this.currentProcessingAbortController = null
      }
      return;
    } else {
      // Debug mode
      const extraScreenshotQueue = this.appState.getScreenshotHelper().getExtraScreenshotQueue()
      if (extraScreenshotQueue.length === 0) {
        console.log("No extra screenshots to process")
        mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.NO_SCREENSHOTS)
        return
      }

      mainWindow.webContents.send(this.appState.PROCESSING_EVENTS.DEBUG_START)
      this.currentExtraProcessingAbortController = new AbortController()
      const signal = this.currentExtraProcessingAbortController.signal

      try {
        const problemInfo = this.appState.getProblemInfo()

        // If no problem info exists, treat the extra screenshot as a new problem
        if (!problemInfo) {
          console.log("[ProcessingHelper] No problem info available, processing extra screenshot as new problem")
          const lastExtraPath = extraScreenshotQueue[extraScreenshotQueue.length - 1]
          const result = await this.llmHelper.solveImageProblem(lastExtraPath, signal)

          const newProblemInfo = {
            problem_statement: result.problemInfo.problem_statement,
            problem_type: result.problemInfo.problem_type,
            language: result.problemInfo.language,
            input_format: result.problemInfo.input_format,
            output_format: result.problemInfo.output_format,
            complexity: result.problemInfo.complexity,
            test_cases: result.problemInfo.test_cases || [] as any[],
            validation_type: result.problemInfo.validation_type,
            difficulty: result.problemInfo.difficulty
          }
          this.appState.setProblemInfo(newProblemInfo)

          mainWindow.webContents.send(
            this.appState.PROCESSING_EVENTS.DEBUG_SUCCESS,
            { solution: result.solution }
          )
          return
        }

        const currentSolution = await this.llmHelper.generateSolution(problemInfo, signal)
        const currentCode = currentSolution.solution.code

        const debugResult = await this.llmHelper.debugSolutionWithImages(
          problemInfo,
          currentCode,
          extraScreenshotQueue,
          signal
        )

        this.appState.setHasDebugged(true)
        mainWindow.webContents.send(
          this.appState.PROCESSING_EVENTS.DEBUG_SUCCESS,
          debugResult
        )

      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        console.error("Debug processing error:", message)
        mainWindow.webContents.send(
          this.appState.PROCESSING_EVENTS.DEBUG_ERROR,
          message
        )
      } finally {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  public cancelOngoingRequests(): void {
    // These signals are now actually attached to the outgoing fetch, so aborting
    // stops the local generation instead of leaving it running on the GPU.
    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort()
      this.currentProcessingAbortController = null
    }

    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort()
      this.currentExtraProcessingAbortController = null
    }

    this.appState.setHasDebugged(false)
  }

  public async processAudioBase64(data: string, mimeType: string) {
    return this.llmHelper.analyzeAudioFromBase64(data, mimeType);
  }

  public async processAudioFile(filePath: string) {
    return this.llmHelper.analyzeAudioFile(filePath);
  }

  public getLLMHelper() {
    return this.llmHelper;
  }
}

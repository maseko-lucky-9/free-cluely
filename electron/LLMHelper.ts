import fs from "fs";

interface OllamaGenerateResponse {
  response?: string;
  /**
   * Ollama routes chain-of-thought here, NOT into `response`. The previous
   * version of this file did not declare it, so on thinking models most of the
   * generation budget landed in a field that was silently discarded.
   */
  thinking?: string;
  done?: boolean;
  done_reason?: string;
  error?: string;
}

interface OllamaModelInfo {
  name: string;
  capabilities: string[];
}

const EMBEDDING_CAPABILITY = "embedding";
const VISION_CAPABILITY = "vision";

export class LLMHelper {
  private ollamaModel: string = "";
  private ollamaUrl: string;
  private requestedModel?: string;

  private models: OllamaModelInfo[] = [];
  private ready: Promise<void>;
  private initError: string | null = null;

  private readonly numCtx: number;
  private readonly numPredict: number;
  private readonly timeoutMs: number;
  private readonly keepAlive: string;

  constructor(ollamaModel?: string, ollamaUrl?: string) {
    this.ollamaUrl = ollamaUrl || "http://localhost:11434";
    this.requestedModel = ollamaModel;

    // A full-resolution screenshot costs a lot of image tokens. Ollama's default
    // context (~2048) silently truncates it, so the model answers on a fragment.
    this.numCtx = Number(process.env.OLLAMA_NUM_CTX) || 16384;
    this.numPredict = Number(process.env.OLLAMA_NUM_PREDICT) || 2048;
    this.timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 180_000;
    this.keepAlive = process.env.OLLAMA_KEEP_ALIVE || "10m";

    this.ready = this.initialize();
  }

  // ---------------------------------------------------------------------------
  // Initialisation & model selection
  // ---------------------------------------------------------------------------

  private async initialize(): Promise<void> {
    this.initError = null;
    try {
      this.models = await this.fetchModels();
    } catch (error) {
      this.initError = `Cannot reach Ollama at ${this.ollamaUrl}: ${this.errText(error)}`;
      return;
    }

    if (this.models.length === 0) {
      this.initError = `Ollama at ${this.ollamaUrl} has no models installed. Run: ollama pull qwen2.5vl:7b`;
      return;
    }

    const chosen = this.selectModel(this.requestedModel);
    if (!chosen) {
      this.initError =
        "No vision-capable model installed. This app sends screenshots, so a vision model is required. " +
        "Run: ollama pull qwen2.5vl:7b";
      return;
    }

    this.ollamaModel = chosen;
    console.log(`[LLMHelper] Using Ollama model: ${this.ollamaModel} (${this.ollamaUrl})`);
  }

  /**
   * Resolves a model name to an installed tag.
   *
   * Two bugs this fixes: bare names ("llama3.2") never matched the fully
   * qualified tags returned by /api/tags ("llama3.2:latest"), so an explicit
   * OLLAMA_MODEL was silently discarded; and the fallback picked `models[0]`,
   * which is simply the most recently pulled model — an embedding model if the
   * user last ran `ollama pull bge-m3`.
   */
  private selectModel(requested?: string): string | null {
    const generative = this.models.filter(
      (m) => !m.capabilities.includes(EMBEDDING_CAPABILITY),
    );
    const visionCapable = generative.filter((m) =>
      m.capabilities.includes(VISION_CAPABILITY),
    );

    if (requested) {
      const match =
        generative.find((m) => m.name === requested) ??
        generative.find((m) => m.name === `${requested}:latest`) ??
        generative.find((m) => m.name.split(":")[0] === requested);

      if (!match) {
        console.warn(
          `[LLMHelper] Requested model "${requested}" is not installed (or is embedding-only). Falling back to auto-selection.`,
        );
      } else if (!match.capabilities.includes(VISION_CAPABILITY)) {
        console.warn(
          `[LLMHelper] Requested model "${match.name}" has no vision capability; screenshots would be ignored. Falling back to a vision model.`,
        );
      } else {
        return match.name;
      }
    }

    return visionCapable[0]?.name ?? null;
  }

  private async fetchModels(): Promise<OllamaModelInfo[]> {
    const res = await fetch(`${this.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`/api/tags returned ${res.status}`);
    const data = await res.json();
    const raw: any[] = data?.models ?? [];

    // Newer Ollama returns `capabilities` inline on /api/tags. Older builds do
    // not, so fall back to /api/show rather than assuming the field exists.
    const needsShow = raw.some((m) => !Array.isArray(m?.capabilities));
    if (!needsShow) {
      return raw.map((m) => ({ name: m.name, capabilities: m.capabilities }));
    }

    return Promise.all(
      raw.map(async (m) => ({
        name: m.name,
        capabilities: await this.fetchCapabilities(m.name),
      })),
    );
  }

  private async fetchCapabilities(name: string): Promise<string[]> {
    try {
      const res = await fetch(`${this.ollamaUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data?.capabilities) ? data.capabilities : [];
    } catch {
      return [];
    }
  }

  /**
   * Awaited by every public method. Re-initialises if the first attempt failed,
   * so starting `ollama serve` after the app launched recovers without a restart.
   */
  private async ensureReady(): Promise<void> {
    await this.ready;
    if (this.initError || !this.ollamaModel) {
      this.ready = this.initialize();
      await this.ready;
    }
    if (this.initError) throw new Error(this.initError);
  }

  private errText(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private currentModelInfo(): OllamaModelInfo | undefined {
    return this.models.find((m) => m.name === this.ollamaModel);
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error;
        const reason = this.errText(error);
        const retryable =
          reason.includes("fetch failed") ||
          reason.includes("ECONNREFUSED") ||
          / 5\d\d/.test(reason) ||
          reason.includes(" 429");
        if (!retryable || i === attempts - 1) throw error;
        const delay = 500 * 2 ** i;
        console.warn(`[LLMHelper] Retry ${i + 1}/${attempts - 1} in ${delay}ms: ${reason}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  private async callOllama(
    prompt: string,
    images?: string[],
    opts?: { schema?: object; temperature?: number; signal?: AbortSignal },
  ): Promise<string> {
    await this.ensureReady();

    const body: Record<string, unknown> = {
      model: this.ollamaModel,
      prompt,
      stream: false,
      keep_alive: this.keepAlive,
      options: {
        // Structured output degrades badly at high temperature; the previous
        // version hardcoded 0.7 for every call, including the JSON ones.
        temperature: opts?.temperature ?? (opts?.schema ? 0 : 0.7),
        top_p: 0.9,
        num_ctx: this.numCtx,
        num_predict: this.numPredict,
      },
    };

    if (images?.length) body.images = images;
    if (opts?.schema) body.format = opts.schema;

    // `think` is load-bearing, NOT an optimisation. Measured on Ollama 0.33.2:
    // with `format` set and `think` absent, a thinking model spends its entire
    // budget in the `thinking` field and returns response:"" — which then fails
    // to parse. Sending think:false also cut real extraction from 21.9s to 6.7s.
    // Models without thinking support accept think:false silently; the retry
    // below covers any that do not.
    body.think = this.ollamaModel.includes("gpt-oss")
      ? process.env.OLLAMA_THINK_LEVEL || "low"
      : false;

    const attempt = async (): Promise<string> => {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

      let res: Response;
      try {
        res = await fetch(`${this.ollamaUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error: unknown) {
        if (opts?.signal?.aborted) throw new Error("Request cancelled");
        if (timeout.aborted) {
          throw new Error(
            `Ollama did not respond within ${Math.round(this.timeoutMs / 1000)}s using ${this.ollamaModel}. ` +
              "The model may be too large for this machine — try a smaller one, or raise OLLAMA_TIMEOUT_MS.",
          );
        }
        throw new Error(
          `Failed to reach Ollama at ${this.ollamaUrl}: ${this.errText(error)}. Is 'ollama serve' running?`,
        );
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        if (res.status === 400 && /think/i.test(detail) && "think" in body) {
          delete body.think;
          console.warn(`[LLMHelper] ${this.ollamaModel} rejected the think field; retrying without it.`);
          return attempt();
        }
        throw new Error(`Ollama API error ${res.status}: ${detail.slice(0, 400)}`);
      }

      const data: OllamaGenerateResponse = await res.json();
      if (data.error) throw new Error(`Ollama error: ${data.error}`);

      if (data.done_reason === "length") {
        throw new Error(
          `${this.ollamaModel} hit the output limit before finishing (num_predict=${this.numPredict}). ` +
            "The answer would be truncated — try a stronger model or raise OLLAMA_NUM_PREDICT.",
        );
      }

      const text = data.response ?? "";
      if (!text.trim()) {
        throw new Error(
          `${this.ollamaModel} returned an empty response` +
            (data.thinking ? " (all output went to the reasoning channel)" : "") +
            ". Try a different model or raise OLLAMA_NUM_PREDICT.",
        );
      }
      return text;
    };

    return this.withRetry(attempt);
  }

  // ---------------------------------------------------------------------------
  // JSON handling
  // ---------------------------------------------------------------------------

  private escapeControlCharsInStrings(text: string): string {
    let result = "";
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (escape) {
        result += char;
        escape = false;
        continue;
      }
      if (char === "\\" && inString) {
        result += char;
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        result += char;
        continue;
      }
      if (inString) {
        if (char === "\n") { result += "\\n"; continue; }
        if (char === "\r") { result += "\\r"; continue; }
        if (char === "\t") { result += "\\t"; continue; }
      }
      result += char;
    }
    return result;
  }

  private cleanJsonResponse(text: string): string {
    // Some models emit reasoning inline despite the `thinking` channel.
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
    text = text
      .replace(/```(?:json|javascript|typescript|csharp|python)?\s*\n?/gi, "")
      .replace(/```/g, "");
    text = this.escapeControlCharsInStrings(text);

    const extracted = this.extractBalancedJson(text);
    if (extracted) return extracted.trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return jsonMatch[0].trim();
    return text.trim();
  }

  private extractBalancedJson(text: string): string | null {
    const startIdx = text.indexOf("{");
    if (startIdx === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < text.length; i++) {
      const char = text[i];
      if (escape) { escape = false; continue; }
      if (char === "\\" && inString) { escape = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (!inString) {
        if (char === "{") depth++;
        if (char === "}") depth--;
        if (depth === 0) return text.substring(startIdx, i + 1);
      }
    }
    return null;
  }

  private closeTruncatedJson(text: string): string {
    let inString = false;
    let escape = false;
    const stack: string[] = [];

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (escape) { escape = false; continue; }
      if (char === "\\" && inString) { escape = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "{") stack.push("}");
      else if (char === "[") stack.push("]");
      else if (char === "}" || char === "]") stack.pop();
    }

    let repaired = text;
    if (inString) repaired += '"';
    repaired = repaired.replace(/,\s*$/, "");
    while (stack.length) repaired += stack.pop();
    return repaired;
  }

  /**
   * Parses model output, or THROWS.
   *
   * The previous implementation returned a typed fallback whose `code` field was
   * the raw model text. The UI rendered that as a real answer — prose displayed
   * with line numbers as Python source — with no error anywhere. A wrong answer
   * presented confidently is worse than a visible failure, so this throws now.
   * `isValid` guards the other half of that bug: an unchecked `as T` cast that
   * let `{"step":1}` through and left the UI spinning forever.
   */
  private parseJson<T>(text: string, isValid: (v: any) => boolean, what: string): T {
    const cleaned = this.cleanJsonResponse(text);
    const noTrailingCommas = cleaned.replace(/,\s*([\]}])/g, "$1");

    // NOTE: the old stage-2 repair also ran .replace(/'/g, '"') globally, which
    // turned "don't" into "don"t" — corrupting otherwise repairable JSON.
    const candidates: string[] = [
      cleaned,
      noTrailingCommas,
      this.closeTruncatedJson(noTrailingCommas),
    ];

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (isValid(parsed)) return parsed as T;
      } catch {
        /* try the next repair */
      }
    }

    console.error(`[LLMHelper] Unusable ${what} output:`, text.slice(0, 800));
    throw new Error(
      `${this.ollamaModel} did not return usable ${what}. ` +
        "This usually means the model is too small for structured output — try a stronger one.",
    );
  }

  // ---------------------------------------------------------------------------
  // Schemas
  // ---------------------------------------------------------------------------

  private static readonly CLASSIFICATION_SCHEMA = {
    type: "object",
    properties: {
      problem_type: { type: "string", enum: ["coding", "mcq", "general"] },
      language: { type: "string" },
      problem_statement: { type: "string" },
      code_snippet: { type: "string" },
      options: { type: "array", items: { type: "string" } },
      constraints: { type: "array", items: { type: "string" } },
      examples: { type: "array", items: { type: "string" } },
    },
    required: ["problem_type", "problem_statement", "language"],
  };

  private static readonly SOLUTION_SCHEMA = {
    type: "object",
    properties: {
      solution: {
        type: "object",
        properties: {
          code: { type: "string" },
          language: { type: "string" },
          problem_statement: { type: "string" },
          explanation: { type: "string" },
          time_complexity: { type: "string" },
          space_complexity: { type: "string" },
          thoughts: { type: "array", items: { type: "string" } },
        },
        required: ["code", "explanation", "thoughts"],
      },
    },
    required: ["solution"],
  };

  private static hasSolution(v: any): boolean {
    return (
      !!v && typeof v === "object" && !!v.solution && typeof v.solution.code === "string"
    );
  }

  private defaultLanguage(): string {
    return process.env.DEFAULT_LANGUAGE || "Python";
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Extracts, classifies and solves a problem from a screenshot.
   * The image goes to BOTH stages so the solver sees layout, diagrams and
   * indentation that the extracted text loses.
   */
  public async solveImageProblem(imagePath: string, signal?: AbortSignal) {
    const imageData = await fs.promises.readFile(imagePath);
    const imageBase64 = imageData.toString("base64");

    const classificationPrompt = `Analyze this screenshot of a technical question and extract its content.

Determine the problem type:
1. "coding" - a programming/algorithm problem asking for a code implementation
2. "mcq" - a multiple-choice question with options
3. "general" - any other question

Also determine "language": the programming language the answer must be written in.
Read it from the screenshot itself - the language selector, the function signature,
the file extension, or the syntax of any starter code. If no language is indicated,
use "${this.defaultLanguage()}".

Extract ALL text, code snippets and details visible in the image.
Return ONLY a JSON object. No markdown fences, no text outside the JSON.`;

    console.log("[LLMHelper] Extracting and classifying problem from screenshot...");

    const classificationText = await this.callOllama(classificationPrompt, [imageBase64], {
      schema: LLMHelper.CLASSIFICATION_SCHEMA,
      signal,
    });

    const problemData = this.parseJson<any>(
      classificationText,
      (v) => !!v && typeof v.problem_statement === "string" && !!v.problem_statement.trim(),
      "problem extraction",
    );

    const language = (problemData.language || this.defaultLanguage()).trim();
    console.log(
      `[LLMHelper] Classified as: ${problemData.problem_type} / language: ${language}`,
    );

    const solutionPrompt = this.buildSolutionPrompt(problemData, language);

    console.log("[LLMHelper] Generating solution with image context...");
    const solutionText = await this.callOllama(solutionPrompt, [imageBase64], {
      schema: LLMHelper.SOLUTION_SCHEMA,
      signal,
    });

    const solutionData = this.parseJson<any>(solutionText, LLMHelper.hasSolution, "solution");

    return {
      problemInfo: {
        problem_statement: problemData.problem_statement,
        problem_type: problemData.problem_type,
        language,
        code_snippet: problemData.code_snippet ?? null,
        options: problemData.options ?? null,
        constraints: problemData.constraints ?? [],
        examples: problemData.examples ?? [],
        input_format: {
          description: "Extracted from image",
          parameters: [] as Array<{ name: string; type: string }>,
        },
        output_format: {
          description: "Generated solution",
          type: "string",
          subtype: "code",
        },
        complexity: {
          time: solutionData.solution?.time_complexity || "N/A",
          space: solutionData.solution?.space_complexity || "N/A",
        },
        test_cases: [] as Array<{ input: string; output: string }>,
        validation_type: "auto",
        difficulty: "extracted",
      },
      solution: {
        ...solutionData.solution,
        language: solutionData.solution.language || language,
      },
      timestamp: Date.now(),
    };
  }

  private buildSolutionPrompt(problemData: any, language: string): string {
    if (problemData.problem_type === "mcq") {
      const options: string[] = problemData.options ?? [];
      return `You are an expert at multiple-choice technical questions.

Question:
${problemData.problem_statement}

Options:
${options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n") || "Options not clearly visible"}

Give the correct answer with detailed reasoning. Put "The correct answer is: [LETTER]. [text]"
in "code", your reasoning in "explanation", and the key steps in "thoughts".
Return ONLY a JSON object.`;
    }

    if (problemData.problem_type === "coding") {
      const existing = problemData.code_snippet
        ? `\nExisting Code:\n${problemData.code_snippet}\n`
        : "";
      const constraints = problemData.constraints?.length
        ? `\nConstraints:\n${problemData.constraints.join("\n")}\n`
        : "";
      const examples = problemData.examples?.length
        ? `\nExamples:\n${problemData.examples.join("\n")}\n`
        : "";

      return `You are an expert ${language} programmer. Solve this problem completely.

Problem Statement:
${problemData.problem_statement}
${existing}${constraints}${examples}
The code MUST be complete, correct and executable ${language}. If the problem supplies a
function signature or class name, match it exactly. Set "language" to "${language}".
Return ONLY a JSON object.`;
    }

    const context = problemData.code_snippet ? `\nContext:\n${problemData.code_snippet}\n` : "";
    return `Solve this problem completely.

Problem:
${problemData.problem_statement}
${context}
Put the answer in "code", a detailed explanation in "explanation", and key points in "thoughts".
Return ONLY a JSON object.`;
  }

  public async generateSolution(problemInfo: any, signal?: AbortSignal) {
    const language = problemInfo?.language || this.defaultLanguage();
    const prompt = `Given this problem:
${JSON.stringify(problemInfo, null, 2)}

Provide a complete solution in ${language}. Put the code in "code", a step-by-step
explanation in "explanation", and key insights in "thoughts".
Return ONLY a JSON object.`;

    console.log("[LLMHelper] Generating solution...");
    const text = await this.callOllama(prompt, undefined, {
      schema: LLMHelper.SOLUTION_SCHEMA,
      signal,
    });
    return this.parseJson<any>(text, LLMHelper.hasSolution, "solution");
  }

  public async debugSolutionWithImages(
    problemInfo: any,
    currentCode: string,
    debugImagePaths: string[],
    signal?: AbortSignal,
  ) {
    const images = await Promise.all(
      debugImagePaths.map(async (p) => (await fs.promises.readFile(p)).toString("base64")),
    );
    const language = problemInfo?.language || this.defaultLanguage();

    const prompt = `Given:
1. The original problem: ${JSON.stringify(problemInfo, null, 2)}
2. The current ${language} solution:
${currentCode}
3. The debug information in the provided screenshots

Analyse the debug information and return an improved solution in ${language}.
Put the corrected code in "code", what was wrong and why in "explanation",
and the key fixes in "thoughts".
Return ONLY a JSON object.`;

    const text = await this.callOllama(prompt, images, {
      schema: LLMHelper.SOLUTION_SCHEMA,
      signal,
    });
    return this.parseJson<any>(text, LLMHelper.hasSolution, "debug solution");
  }

  public async analyzeImageFile(imagePath: string, signal?: AbortSignal) {
    const imageData = await fs.promises.readFile(imagePath);
    const prompt = `Describe the content of this image in a short, concise answer. Then suggest
a few actions the user could take next. Answer naturally; do not return JSON. Be brief.`;
    const text = await this.callOllama(prompt, [imageData.toString("base64")], { signal });
    return { text, timestamp: Date.now() };
  }

  /**
   * Audio is not supported locally.
   *
   * The previous implementation discarded the audio bytes and still asked the
   * model to "describe this audio clip" — so it invented one, and the UI
   * presented the invention as a transcript of the user's own recording.
   */
  private audioUnsupported(): never {
    throw new Error(
      "Audio analysis is not available in local mode. Ollama's /api/generate cannot accept audio, " +
        "and answering from the prompt alone would fabricate a transcript.",
    );
  }

  public async analyzeAudioFile(_audioPath: string): Promise<never> {
    return this.audioUnsupported();
  }

  public async analyzeAudioFromBase64(_data: string, _mimeType: string): Promise<never> {
    return this.audioUnsupported();
  }

  public static readonly AUDIO_SUPPORTED = false;

  public async chat(message: string, signal?: AbortSignal): Promise<string> {
    return this.callOllama(message, undefined, { signal });
  }

  // ---------------------------------------------------------------------------
  // Configuration surface
  // ---------------------------------------------------------------------------

  public isUsingOllama(): boolean {
    return true;
  }

  public getCurrentProvider(): "ollama" {
    return "ollama";
  }

  public getCurrentModel(): string {
    return this.ollamaModel;
  }

  public getOllamaUrl(): string {
    return this.ollamaUrl;
  }

  /** Installed models that can actually generate (embedding models excluded). */
  public async getOllamaModels(): Promise<string[]> {
    try {
      if (this.models.length === 0) this.models = await this.fetchModels();
    } catch (error) {
      console.error("[LLMHelper] Error fetching Ollama models:", this.errText(error));
      return [];
    }
    return this.models
      .filter((m) => !m.capabilities.includes(EMBEDDING_CAPABILITY))
      .map((m) => m.name);
  }

  /** Installed models that can accept screenshots — the ones this app can use. */
  public async getVisionModels(): Promise<string[]> {
    await this.getOllamaModels();
    return this.models
      .filter((m) => m.capabilities.includes(VISION_CAPABILITY))
      .map((m) => m.name);
  }

  /**
   * Switches model. Validates before reporting success — the previous version
   * returned {success:true} with no existence or capability check, so selecting
   * an embedding model produced a green "Connected successfully" followed by
   * failure on every request.
   */
  public async switchToOllama(model?: string, url?: string): Promise<void> {
    if (url) this.ollamaUrl = url;
    this.requestedModel = model || undefined;
    this.models = [];
    this.ready = this.initialize();
    await this.ready;
    if (this.initError) throw new Error(this.initError);

    if (model) {
      const resolved = this.selectModel(model);
      if (!resolved || resolved !== this.ollamaModel) {
        throw new Error(
          `Model "${model}" is not usable: it must be installed and support vision. Using "${this.ollamaModel}" instead.`,
        );
      }
    }
    console.log(`[LLMHelper] Switched to ${this.ollamaModel} at ${this.ollamaUrl}`);
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.ensureReady();
      await this.callOllama("Reply with the single word: ok");
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: this.errText(error) };
    }
  }
}

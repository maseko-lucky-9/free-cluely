import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import fs from "fs";

interface OllamaResponse {
  response: string;
  done: boolean;
}

export class LLMHelper {
  private model: GenerativeModel | null = null;
  private textModel: GenerativeModel | null = null; // For non-JSON responses (chat, audio, image analysis)
  private apiKey: string | undefined;
  private readonly systemPrompt = `You are Wingman AI, a helpful, proactive assistant for any kind of problem or situation (not just coding). For any user input, analyze the situation, provide a clear problem statement, relevant context, and suggest several possible responses or actions the user could take next. Always explain your reasoning. Present your suggestions as a list of options or next steps.`;
  private useOllama: boolean = false;
  private ollamaModel: string = "llama3.2";
  private ollamaUrl: string = "http://localhost:11434";

  constructor(
    apiKey?: string,
    useOllama: boolean = false,
    ollamaModel?: string,
    ollamaUrl?: string,
  ) {
    this.useOllama = useOllama;

    if (useOllama) {
      this.ollamaUrl = ollamaUrl || "http://localhost:11434";
      this.ollamaModel = ollamaModel || "gemma:latest"; // Default fallback
      console.log(`[LLMHelper] Using Ollama with model: ${this.ollamaModel}`);

      // Auto-detect and use first available model if specified model doesn't exist
      this.initializeOllamaModel();
    } else if (apiKey) {
      this.apiKey = apiKey;
      const genAI = new GoogleGenerativeAI(apiKey);
      this.model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.7,
          maxOutputTokens: 65536,
        },
      });
      this.textModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
          temperature: 0.7,
        },
      });
      console.log("[LLMHelper] Using Google Gemini (JSON mode enabled)");
    } else {
      throw new Error("Either provide Gemini API key or enable Ollama mode");
    }
  }

  private async fileToGenerativePart(imagePath: string) {
    const imageData = await fs.promises.readFile(imagePath);
    return {
      inlineData: {
        data: imageData.toString("base64"),
        mimeType: "image/png",
      },
    };
  }

  /**
   * Escapes literal control characters (newlines, carriage returns, tabs)
   * that appear INSIDE JSON string values. Gemini's JSON mode sometimes
   * outputs actual 0x0A newlines inside string values instead of the
   * properly escaped \n sequence, making the JSON invalid for JSON.parse().
   *
   * This walks the text char-by-char, tracking JSON string boundaries,
   * and only escapes control chars found within strings.
   */
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
        // Replace literal control characters with JSON escape sequences
        if (char === "\n") { result += "\\n"; continue; }
        if (char === "\r") { result += "\\r"; continue; }
        if (char === "\t") { result += "\\t"; continue; }
      }

      result += char;
    }

    return result;
  }

  private cleanJsonResponse(text: string): string {
    // Strategy 1: Strip ALL markdown code fences (not just first/last)
    text = text
      .replace(/```(?:json|javascript|typescript)?\s*\n?/gi, "")
      .replace(/```/g, "");

    // Strategy 2: Escape literal control chars inside JSON string values
    // (Gemini sometimes outputs 0x0A inside strings instead of \n)
    text = this.escapeControlCharsInStrings(text);

    // Strategy 3: Try to find the first balanced JSON object
    const extracted = this.extractBalancedJson(text);
    if (extracted) {
      return extracted.trim();
    }

    // Strategy 4: Greedy fallback — match from first { to last }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0].trim();
    }

    return text.trim();
  }

  /**
   * Extracts the first balanced JSON object from text by counting braces.
   * Handles nested objects, strings containing braces, and escaped characters.
   */
  private extractBalancedJson(text: string): string | null {
    const startIdx = text.indexOf("{");
    if (startIdx === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < text.length; i++) {
      const char = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === "\\" && inString) {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === "{") depth++;
        if (char === "}") depth--;
        if (depth === 0) {
          return text.substring(startIdx, i + 1);
        }
      }
    }

    return null; // Unbalanced
  }

  /**
   * Resilient JSON parse with a multi-stage repair pipeline.
   * Falls back to a typed default when all parse strategies fail.
   *
   * Stages:
   *  1. Direct parse of cleaned text
   *  2. Repair trailing commas & single quotes
   *  3. Attempt to close truncated JSON (unbalanced braces/brackets)
   *  4. Last resort: extract any JSON-like substring and re-parse
   *  5. Return typed fallback
   */
  private safeParseJson<T>(text: string, fallback: T): T {
    // Stage 1: Direct parse after cleaning
    const cleaned = this.cleanJsonResponse(text);
    try {
      return JSON.parse(cleaned);
    } catch (_e1) {
      // Stage 2: Repair common issues — trailing commas, single quotes, unquoted keys
      const repaired = cleaned
        .replace(/,\s*([\]}])/g, "$1") // trailing commas
        .replace(/'/g, '"') // single → double quotes
        .replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":'); // unquoted keys
      try {
        return JSON.parse(repaired);
      } catch (_e2) {
        // Stage 3: Attempt to close truncated JSON
        const closed = this.attemptCloseTruncatedJson(repaired);
        if (closed) {
          try {
            return JSON.parse(closed);
          } catch (_e3) {
            // fall through
          }
        }

        // Stage 4: Last resort — extract deepest valid JSON substring
        const lastResort = this.extractLargestParsableJson(cleaned);
        if (lastResort !== null) {
          return lastResort as T;
        }

        console.error(
          "[LLMHelper] JSON parse failed after all repair stages. Raw text:",
          text.substring(0, 500),
        );
        return fallback;
      }
    }
  }

  /**
   * Attempts to close truncated JSON by appending missing closing brackets.
   * Handles cases where the response was cut off mid-object or mid-array.
   */
  private attemptCloseTruncatedJson(text: string): string | null {
    // Remove any trailing incomplete string value (text cut mid-string)
    let working = text.replace(/,\s*"[^"]*$/, ""); // trailing incomplete key
    working = working.replace(/:\s*"[^"]*$/, ': ""'); // trailing incomplete value
    working = working.replace(/,\s*$/, ""); // trailing comma

    // Count unbalanced braces and brackets
    let braces = 0;
    let brackets = 0;
    let inString = false;
    let escape = false;

    for (const char of working) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\" && inString) {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "{") braces++;
        if (char === "}") braces--;
        if (char === "[") brackets++;
        if (char === "]") brackets--;
      }
    }

    // If already balanced or over-closed, can't repair
    if (braces <= 0 && brackets <= 0) return null;

    // Close open brackets then braces
    working += "]".repeat(brackets) + "}".repeat(braces);
    return working;
  }

  /**
   * Tries to find and parse the largest valid JSON substring within text.
   * Progressively trims from the end to find a parsable prefix.
   */
  private extractLargestParsableJson(text: string): unknown | null {
    const startIdx = text.indexOf("{");
    if (startIdx === -1) return null;

    // Try progressively shorter substrings ending at each }
    const bracePositions: number[] = [];
    for (let i = text.length - 1; i > startIdx; i--) {
      if (text[i] === "}") bracePositions.push(i);
    }

    for (const endIdx of bracePositions) {
      try {
        return JSON.parse(text.substring(startIdx, endIdx + 1));
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Retry wrapper with exponential backoff for LLM API calls.
   * Retries on rate limits (429), server errors (500/503), and network errors.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        const errObj = error as { status?: number; message?: string };
        const isRetryable =
          errObj.status === 429 ||
          (errObj.status !== undefined && errObj.status >= 500) ||
          errObj.message?.includes("ECONNRESET") ||
          errObj.message?.includes("network") ||
          errObj.message?.includes("fetch failed");
        if (attempt === maxRetries || !isRetryable) throw error;
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        console.warn(
          `[LLMHelper] Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms:`,
          errObj.message,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("Unreachable");
  }

  private async callOllama(prompt: string, images?: string[]): Promise<string> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.ollamaModel,
          prompt: prompt,
          images: images,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Ollama API error: ${response.status} ${response.statusText}`,
        );
      }

      const data: OllamaResponse = await response.json();
      return data.response;
    } catch (error) {
      console.error("[LLMHelper] Error calling Ollama:", error);
      throw new Error(
        `Failed to connect to Ollama: ${error.message}. Make sure Ollama is running on ${this.ollamaUrl}`,
      );
    }
  }

  private async checkOllamaAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async initializeOllamaModel(): Promise<void> {
    try {
      const availableModels = await this.getOllamaModels();
      if (availableModels.length === 0) {
        console.warn("[LLMHelper] No Ollama models found");
        return;
      }

      // Check if current model exists, if not use the first available
      if (!availableModels.includes(this.ollamaModel)) {
        this.ollamaModel = availableModels[0];
        console.log(
          `[LLMHelper] Auto-selected first available model: ${this.ollamaModel}`,
        );
      }

      // Test the selected model works
      const testResult = await this.callOllama("Hello");
      console.log(
        `[LLMHelper] Successfully initialized with model: ${this.ollamaModel}`,
      );
    } catch (error) {
      console.error(
        `[LLMHelper] Failed to initialize Ollama model: ${error.message}`,
      );
      // Try to use first available model as fallback
      try {
        const models = await this.getOllamaModels();
        if (models.length > 0) {
          this.ollamaModel = models[0];
          console.log(`[LLMHelper] Fallback to: ${this.ollamaModel}`);
        }
      } catch (fallbackError) {
        console.error(
          `[LLMHelper] Fallback also failed: ${fallbackError.message}`,
        );
      }
    }
  }

  public async extractProblemFromImages(imagePaths: string[]) {
    try {
      const imageParts = await Promise.all(
        imagePaths.map((path) => this.fileToGenerativePart(path)),
      );

      const prompt = `${this.systemPrompt}\n\nYou are a wingman. Please analyze these images and extract the following information in JSON format:\n{
  "problem_statement": "A clear statement of the problem or situation depicted in the images.",
  "context": "Relevant background or context from the images.",
  "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
  "reasoning": "Explanation of why these suggestions are appropriate."
}\n\nCRITICAL: Return ONLY a valid JSON object. Do NOT wrap in markdown code fences. Do NOT include any text outside the JSON object.`;

      if (!this.useOllama && !this.model) {
        throw new Error(
          "LLM not configured: Neither Ollama nor Gemini is active",
        );
      }

      if (this.useOllama) {
        const images = await Promise.all(
          imagePaths.map(async (path) => {
            const data = await fs.promises.readFile(path);
            return data.toString("base64");
          }),
        );
        const responseText = await this.callOllama(prompt, images);
        return this.safeParseJson(responseText, {
          problem_statement: "Could not parse problem from image",
          context: "",
          suggested_responses: [],
          reasoning: "",
        });
      }

      const result = await this.model.generateContent([prompt, ...imageParts]);
      const response = await result.response;
      const text = response.text();
      return this.safeParseJson(text, {
        problem_statement: "Could not parse problem from image",
        context: "",
        suggested_responses: [],
        reasoning: "",
      });
    } catch (error) {
      console.error("Error extracting problem from images:", error);
      throw error;
    }
  }

  public async generateSolution(problemInfo: any) {
    const prompt = `${this.systemPrompt}\n\nGiven this problem or situation:\n${JSON.stringify(problemInfo, null, 2)}\n\nPlease provide your response in the following JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\n\nCRITICAL: Return ONLY a valid JSON object. Do NOT wrap in markdown code fences. Do NOT include any text outside the JSON object.`;

    console.log("[LLMHelper] Calling LLM for solution...");

    if (!this.useOllama && !this.model) {
      throw new Error(
        "LLM not configured: Neither Ollama nor Gemini is active",
      );
    }

    try {
      if (this.useOllama) {
        console.log("[LLMHelper] Calling Ollama for solution...");
        const responseText = await this.callOllama(prompt);
        console.log("[LLMHelper] Ollama returned result.");
        const parsed = this.safeParseJson(responseText, {
          solution: {
            code: responseText,
            problem_statement: "",
            context: "",
            suggested_responses: [],
            reasoning: "Response could not be parsed as structured JSON",
          },
        });
        console.log("[LLMHelper] Parsed LLM response:", parsed);
        return parsed;
      }

      const result = await this.model.generateContent(prompt);
      console.log("[LLMHelper] Gemini LLM returned result.");
      const response = await result.response;
      const text = response.text();
      const parsed = this.safeParseJson(text, {
        solution: {
          code: text,
          problem_statement: "",
          context: "",
          suggested_responses: [],
          reasoning: "Response could not be parsed as structured JSON",
        },
      });
      console.log("[LLMHelper] Parsed LLM response:", parsed);
      return parsed;
    } catch (error) {
      console.error("[LLMHelper] Error in generateSolution:", error);
      throw error;
    }
  }

  public async debugSolutionWithImages(
    problemInfo: any,
    currentCode: string,
    debugImagePaths: string[],
  ) {
    try {
      const imageParts = await Promise.all(
        debugImagePaths.map((path) => this.fileToGenerativePart(path)),
      );

      const prompt = `${this.systemPrompt}\n\nYou are a wingman. Given:\n1. The original problem or situation: ${JSON.stringify(problemInfo, null, 2)}\n2. The current response or approach: ${currentCode}\n3. The debug information in the provided images\n\nPlease analyze the debug information and provide feedback in this JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\n\nCRITICAL: Return ONLY a valid JSON object. Do NOT wrap in markdown code fences. Do NOT include any text outside the JSON object.`;

      if (!this.useOllama && !this.model) {
        throw new Error(
          "LLM not configured: Neither Ollama nor Gemini is active",
        );
      }

      if (this.useOllama) {
        const images = await Promise.all(
          debugImagePaths.map(async (path) => {
            const data = await fs.promises.readFile(path);
            return data.toString("base64");
          }),
        );
        const responseText = await this.callOllama(prompt, images);
        const parsed = this.safeParseJson(responseText, {
          solution: {
            code: responseText,
            problem_statement: "",
            context: "",
            suggested_responses: [],
            reasoning: "Debug response could not be parsed as structured JSON",
          },
        });
        console.log("[LLMHelper] Parsed debug LLM response:", parsed);
        return parsed;
      }

      const result = await this.model.generateContent([prompt, ...imageParts]);
      const response = await result.response;
      const text = response.text();
      const parsed = this.safeParseJson(text, {
        solution: {
          code: text,
          problem_statement: "",
          context: "",
          suggested_responses: [],
          reasoning: "Debug response could not be parsed as structured JSON",
        },
      });
      console.log("[LLMHelper] Parsed debug LLM response:", parsed);
      return parsed;
    } catch (error) {
      console.error("Error debugging solution with images:", error);
      throw error;
    }
  }

  public async analyzeAudioFile(audioPath: string) {
    try {
      const audioData = await fs.promises.readFile(audioPath);
      const audioPart = {
        inlineData: {
          data: audioData.toString("base64"),
          mimeType: "audio/mp3",
        },
      };
      const prompt = `${this.systemPrompt}\n\nDescribe this audio clip in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the audio. Do not return a structured JSON object, just answer naturally as you would to a user.`;

      if (!this.useOllama && !this.model) {
        throw new Error(
          "LLM not configured: Neither Ollama nor Gemini is active",
        );
      }

      if (this.useOllama) {
        console.warn(
          "[LLMHelper] Ollama audio analysis not fully supported. Sending text prompt only.",
        );
        const responseText = await this.callOllama(prompt);
        return { text: responseText, timestamp: Date.now() };
      }

      const textModelToUse = this.textModel || this.model;
      const result = await textModelToUse!.generateContent([prompt, audioPart]);
      const response = await result.response;
      const text = response.text();
      return { text, timestamp: Date.now() };
    } catch (error) {
      console.error("Error analyzing audio file:", error);
      throw error;
    }
  }

  public async analyzeAudioFromBase64(data: string, mimeType: string) {
    try {
      const audioPart = {
        inlineData: {
          data,
          mimeType,
        },
      };
      const prompt = `${this.systemPrompt}\n\nDescribe this audio clip in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the audio. Do not return a structured JSON object, just answer naturally as you would to a user and be concise.`;

      if (!this.useOllama && !this.model) {
        throw new Error(
          "LLM not configured: Neither Ollama nor Gemini is active",
        );
      }

      if (this.useOllama) {
        console.warn(
          "[LLMHelper] Ollama audio analysis not fully supported. Sending text prompt only.",
        );
        const responseText = await this.callOllama(prompt);
        return { text: responseText, timestamp: Date.now() };
      }

      const textModelToUse = this.textModel || this.model;
      const result = await textModelToUse!.generateContent([prompt, audioPart]);
      const response = await result.response;
      const text = response.text();
      return { text, timestamp: Date.now() };
    } catch (error) {
      console.error("Error analyzing audio from base64:", error);
      throw error;
    }
  }

  public async analyzeImageFile(imagePath: string) {
    try {
      const imageData = await fs.promises.readFile(imagePath);
      const imagePart = {
        inlineData: {
          data: imageData.toString("base64"),
          mimeType: "image/png",
        },
      };
      const prompt = `${this.systemPrompt}\n\nDescribe the content of this image in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the image. Do not return a structured JSON object, just answer naturally as you would to a user. Be concise and brief.`;

      if (!this.useOllama && !this.model) {
        throw new Error(
          "LLM not configured: Neither Ollama nor Gemini is active",
        );
      }

      if (this.useOllama) {
        const base64Image = imageData.toString("base64");
        const responseText = await this.callOllama(prompt, [base64Image]);
        return { text: responseText, timestamp: Date.now() };
      }

      const textModelToUse = this.textModel || this.model;
      const result = await textModelToUse!.generateContent([prompt, imagePart]);
      const response = await result.response;
      const text = response.text();
      return { text, timestamp: Date.now() };
    } catch (error) {
      console.error("Error analyzing image file:", error);
      throw error;
    }
  }

  /**
   * Solves problems from images - extracts, classifies, and generates complete solutions.
   * Handles both coding challenges and multiple-choice questions.
   */
  public async solveImageProblem(imagePath: string) {
    try {
      const imageData = await fs.promises.readFile(imagePath);
      const imagePart = {
        inlineData: {
          data: imageData.toString("base64"),
          mimeType: "image/png",
        },
      };

      // Step 1: Extract and classify the problem from the image
      const classificationPrompt = `Analyze this image carefully and extract the problem content.

Determine the problem type:
1. "coding" - If it's a programming/coding challenge, algorithm problem, or asks for code implementation
2. "mcq" - If it's a multiple-choice question with options (A, B, C, D or similar)
3. "general" - If it's any other type of question or problem

Extract ALL text, code snippets, and problem details visible in the image.

Return ONLY a JSON object in this exact format:
{
  "problem_type": "coding" | "mcq" | "general",
  "problem_statement": "The complete problem statement extracted from the image",
  "code_snippet": "Any existing code shown in the image, or null if none",
  "options": ["Option A text", "Option B text", ...] or null if not MCQ,
  "constraints": ["Any constraints mentioned"],
  "examples": ["Any examples shown"]
}

CRITICAL: Return ONLY a valid JSON object. Do NOT wrap in markdown code fences. Do NOT include any text outside the JSON object.`;

      console.log(
        "[LLMHelper] Extracting and classifying problem from image...",
      );

      let classificationText: string;

      if (this.useOllama) {
        // Use Ollama with vision model (llava, bakllava, etc.)
        const imageBase64 = imageData.toString("base64");
        const ollamaResponse = await this.callOllama(classificationPrompt, [
          imageBase64,
        ]);
        classificationText = this.cleanJsonResponse(ollamaResponse);
      } else {
        // Use Gemini for vision
        if (!this.model) {
          throw new Error(
            "Vision model (Gemini) required for image problem solving. Please configure GEMINI_API_KEY.",
          );
        }
        const classificationResult = await this.model.generateContent([
          classificationPrompt,
          imagePart,
        ]);
        const classificationResponse = await classificationResult.response;
        classificationText = this.cleanJsonResponse(
          classificationResponse.text(),
        );
      }

      let problemData;
      try {
        problemData = JSON.parse(classificationText);
      } catch (parseError) {
        console.warn(
          "[LLMHelper] Failed to parse classification response as JSON, using fallback:",
          classificationText,
        );
        // Fallback: treat as general problem using the raw text
        problemData = {
          problem_type: "general",
          problem_statement: classificationText.substring(0, 2000), // Limit length
          code_snippet: null,
          options: null,
          constraints: [],
          examples: [],
        };
      }

      console.log(
        "[LLMHelper] Problem classified as:",
        problemData.problem_type,
      );

      // Step 2: Generate solution based on problem type
      let solutionPrompt: string;

      if (problemData.problem_type === "coding") {
        solutionPrompt = `You are an expert programmer. Solve this coding problem completely.

Problem Statement:
${problemData.problem_statement}

${problemData.code_snippet ? `Existing Code:\n${problemData.code_snippet}\n` : ""}
${problemData.constraints?.length ? `Constraints:\n${problemData.constraints.join("\n")}\n` : ""}
${problemData.examples?.length ? `Examples:\n${problemData.examples.join("\n")}\n` : ""}

Provide a complete, working solution. Return ONLY a JSON object:
{
  "solution": {
    "code": "Complete working code solution here",
    "language": "C#",
    "problem_statement": "Restated problem",
    "explanation": "Step-by-step explanation of the approach",
    "time_complexity": "O(n) or similar",
    "space_complexity": "O(1) or similar",
    "thoughts": ["Key insight 1", "Key insight 2", "..."]
  }
}

CRITICAL: The code must be complete, correct, and executable C# code. Return ONLY a valid JSON object. Do NOT wrap in markdown code fences. Do NOT include any text outside the JSON object.`;
      } else if (problemData.problem_type === "mcq") {
        solutionPrompt = `You are an expert at solving multiple-choice questions. Analyze this question carefully.

Question:
${problemData.problem_statement}

Options:
${problemData.options?.map((opt: string, i: number) => `${String.fromCharCode(65 + i)}. ${opt}`).join("\n") || "Options not clearly visible"}

Determine the correct answer with detailed reasoning. Return ONLY a JSON object:
{
  "solution": {
    "code": "The correct answer is: [LETTER]. [Full option text]",
    "problem_statement": "The question being asked",
    "correct_answer": "A, B, C, or D",
    "explanation": "Detailed reasoning for why this answer is correct",
    "why_others_wrong": "Brief explanation of why other options are incorrect",
    "thoughts": ["Key reasoning step 1", "Key reasoning step 2", "..."]
  }
}

CRITICAL: Return ONLY a valid JSON object. Do NOT wrap in markdown code fences. Do NOT include any text outside the JSON object.`;
      } else {
        // General problem type
        solutionPrompt = `Solve this problem completely.

Problem:
${problemData.problem_statement}

${problemData.code_snippet ? `Context:\n${problemData.code_snippet}\n` : ""}

Provide a clear, complete solution. Return ONLY a JSON object:
{
  "solution": {
    "code": "Complete answer or solution here",
    "problem_statement": "Restated problem",
    "explanation": "Detailed explanation",
    "thoughts": ["Key point 1", "Key point 2", "..."]
  }
}

CRITICAL: Return ONLY a valid JSON object. Do NOT wrap in markdown code fences. Do NOT include any text outside the JSON object.`;
      }

      console.log("[LLMHelper] Generating solution with image context...");

      let solutionText: string;

      if (this.useOllama) {
        // Use Ollama with vision model for solution generation
        const imageBase64 = imageData.toString("base64");
        const ollamaResponse = await this.callOllama(solutionPrompt, [
          imageBase64,
        ]);
        solutionText = ollamaResponse;
      } else {
        // CRITICAL FIX: Pass the imagePart again so the solver sees the indentation/diagrams/context
        const solutionResult = await this.model!.generateContent([
          solutionPrompt,
          imagePart,
        ]);
        const solutionResponse = await solutionResult.response;
        solutionText = solutionResponse.text();
      }

      const solutionData = this.safeParseJson(solutionText, {
        solution: {
          code: solutionText,
          problem_statement: problemData.problem_statement,
          thoughts: ["Raw solution provided (structured parsing unavailable)"],
          time_complexity: "N/A",
          space_complexity: "N/A",
        },
      });

      console.log("[LLMHelper] Solution generated successfully");

      // Return combined result with problem info and solution
      return {
        problemInfo: {
          problem_statement: problemData.problem_statement,
          problem_type: problemData.problem_type,
          code_snippet: problemData.code_snippet,
          options: problemData.options,
          constraints: problemData.constraints,
          examples: problemData.examples,
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
        solution: solutionData.solution,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error("[LLMHelper] Error solving image problem:", error);
      throw error;
    }
  }

  public async chatWithGemini(message: string): Promise<string> {
    try {
      if (this.useOllama) {
        return this.callOllama(message);
      } else if (this.textModel || this.model) {
        const textModelToUse = this.textModel || this.model;
        const result = await textModelToUse!.generateContent(message);
        const response = await result.response;
        return response.text();
      } else {
        throw new Error("No LLM provider configured");
      }
    } catch (error) {
      console.error("[LLMHelper] Error in chatWithGemini:", error);
      throw error;
    }
  }

  public async chat(message: string): Promise<string> {
    return this.chatWithGemini(message);
  }

  public isUsingOllama(): boolean {
    return this.useOllama;
  }

  public async getOllamaModels(): Promise<string[]> {
    if (!this.useOllama) return [];

    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`);
      if (!response.ok) throw new Error("Failed to fetch models");

      const data = await response.json();
      return data.models?.map((model: any) => model.name) || [];
    } catch (error) {
      console.error("[LLMHelper] Error fetching Ollama models:", error);
      return [];
    }
  }

  public getCurrentProvider(): "ollama" | "gemini" {
    return this.useOllama ? "ollama" : "gemini";
  }

  public getCurrentModel(): string {
    return this.useOllama ? this.ollamaModel : "gemini-2.5-flash";
  }

  public async switchToOllama(model?: string, url?: string): Promise<void> {
    this.useOllama = true;
    if (url) this.ollamaUrl = url;

    if (model) {
      this.ollamaModel = model;
    } else {
      // Auto-detect first available model
      await this.initializeOllamaModel();
    }

    console.log(
      `[LLMHelper] Switched to Ollama: ${this.ollamaModel} at ${this.ollamaUrl}`,
    );
  }

  public async switchToGemini(apiKey?: string): Promise<void> {
    if (apiKey) {
      const genAI = new GoogleGenerativeAI(apiKey);
      this.model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.7,
          maxOutputTokens: 65536,
        },
      });
      this.textModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
          temperature: 0.7,
        },
      });
    }

    if (!this.model && !apiKey) {
      throw new Error(
        "No Gemini API key provided and no existing model instance",
      );
    }

    this.useOllama = false;
    console.log("[LLMHelper] Switched to Gemini");
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.useOllama) {
        const available = await this.checkOllamaAvailable();
        if (!available) {
          return {
            success: false,
            error: `Ollama not available at ${this.ollamaUrl}`,
          };
        }
        // Test with a simple prompt
        await this.callOllama("Hello");
        return { success: true };
      } else {
        if (!this.model) {
          return { success: false, error: "No Gemini model configured" };
        }
        // Test with a simple prompt
        const result = await this.model.generateContent("Hello");
        const response = await result.response;
        const text = response.text(); // Ensure the response is valid
        if (text) {
          return { success: true };
        } else {
          return { success: false, error: "Empty response from Gemini" };
        }
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

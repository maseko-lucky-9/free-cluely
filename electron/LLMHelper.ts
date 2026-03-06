import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai"
import fs from "fs"

interface OllamaResponse {
  response: string
  done: boolean
}

export class LLMHelper {
  private model: GenerativeModel | null = null
  private readonly systemPrompt = `You are Wingman AI, a helpful, proactive assistant for any kind of problem or situation (not just coding). For any user input, analyze the situation, provide a clear problem statement, relevant context, and suggest several possible responses or actions the user could take next. Always explain your reasoning. Present your suggestions as a list of options or next steps.`
  private useOllama: boolean = false
  private ollamaModel: string = "llama3.2"
  private ollamaUrl: string = "http://localhost:11434"

  constructor(apiKey?: string, useOllama: boolean = false, ollamaModel?: string, ollamaUrl?: string) {
    this.useOllama = useOllama
    
    if (useOllama) {
      this.ollamaUrl = ollamaUrl || "http://localhost:11434"
      this.ollamaModel = ollamaModel || "gemma:latest" // Default fallback
      console.log(`[LLMHelper] Using Ollama with model: ${this.ollamaModel}`)
      
      // Auto-detect and use first available model if specified model doesn't exist
      this.initializeOllamaModel()
    } else if (apiKey) {
      const genAI = new GoogleGenerativeAI(apiKey)
      this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" })
      console.log("[LLMHelper] Using Google Gemini")
    } else {
      throw new Error("Either provide Gemini API key or enable Ollama mode")
    }
  }

  private async fileToGenerativePart(imagePath: string) {
    const imageData = await fs.promises.readFile(imagePath)
    return {
      inlineData: {
        data: imageData.toString("base64"),
        mimeType: "image/png"
      }
    }
  }

  private cleanJsonResponse(text: string): string {
    // Remove markdown code block syntax if present (handles ```json, ``` and variations)
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    
    // Try to extract JSON object from the text (Ollama may include extra explanation text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      text = jsonMatch[0];
    }
    
    // Remove any leading/trailing whitespace
    text = text.trim();
    return text;
  }

  private async callOllama(prompt: string, images?: string[]): Promise<string> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.ollamaModel,
          prompt: prompt,
          images: images,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
          }
        }),
      })

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
      }

      const data: OllamaResponse = await response.json()
      return data.response
    } catch (error) {
      console.error("[LLMHelper] Error calling Ollama:", error)
      throw new Error(`Failed to connect to Ollama: ${error.message}. Make sure Ollama is running on ${this.ollamaUrl}`)
    }
  }

  private async checkOllamaAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`)
      return response.ok
    } catch {
      return false
    }
  }

  private async initializeOllamaModel(): Promise<void> {
    try {
      const availableModels = await this.getOllamaModels()
      if (availableModels.length === 0) {
        console.warn("[LLMHelper] No Ollama models found")
        return
      }

      // Check if current model exists, if not use the first available
      if (!availableModels.includes(this.ollamaModel)) {
        this.ollamaModel = availableModels[0]
        console.log(`[LLMHelper] Auto-selected first available model: ${this.ollamaModel}`)
      }

      // Test the selected model works
      const testResult = await this.callOllama("Hello")
      console.log(`[LLMHelper] Successfully initialized with model: ${this.ollamaModel}`)
    } catch (error) {
      console.error(`[LLMHelper] Failed to initialize Ollama model: ${error.message}`)
      // Try to use first available model as fallback
      try {
        const models = await this.getOllamaModels()
        if (models.length > 0) {
          this.ollamaModel = models[0]
          console.log(`[LLMHelper] Fallback to: ${this.ollamaModel}`)
        }
      } catch (fallbackError) {
        console.error(`[LLMHelper] Fallback also failed: ${fallbackError.message}`)
      }
    }
  }

  public async extractProblemFromImages(imagePaths: string[]) {
    try {
      const imageParts = await Promise.all(imagePaths.map(path => this.fileToGenerativePart(path)))
      
      const prompt = `${this.systemPrompt}\n\nYou are a wingman. Please analyze these images and extract the following information in JSON format:\n{
  "problem_statement": "A clear statement of the problem or situation depicted in the images.",
  "context": "Relevant background or context from the images.",
  "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
  "reasoning": "Explanation of why these suggestions are appropriate."
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      if (!this.useOllama && !this.model) {
        throw new Error("LLM not configured: Neither Ollama nor Gemini is active");
      }

      if (this.useOllama) {
        const images = await Promise.all(imagePaths.map(async (path) => {
          const data = await fs.promises.readFile(path);
          return data.toString('base64');
        }));
        const responseText = await this.callOllama(prompt, images);
        const text = this.cleanJsonResponse(responseText);
        return JSON.parse(text);
      }

      const result = await this.model.generateContent([prompt, ...imageParts])
      const response = await result.response
      const text = this.cleanJsonResponse(response.text())
      return JSON.parse(text)
    } catch (error) {
      console.error("Error extracting problem from images:", error)
      throw error
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
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

    console.log("[LLMHelper] Calling LLM for solution...");

    if (!this.useOllama && !this.model) {
      throw new Error("LLM not configured: Neither Ollama nor Gemini is active");
    }

    try {
      if (this.useOllama) {
        console.log("[LLMHelper] Calling Ollama for solution...");
        const responseText = await this.callOllama(prompt);
        console.log("[LLMHelper] Ollama returned result.");
        const text = this.cleanJsonResponse(responseText);
        const parsed = JSON.parse(text);
        console.log("[LLMHelper] Parsed LLM response:", parsed);
        return parsed;
      }

      const result = await this.model.generateContent(prompt)
      console.log("[LLMHelper] Gemini LLM returned result.");
      const response = await result.response
      const text = this.cleanJsonResponse(response.text())
      const parsed = JSON.parse(text)
      console.log("[LLMHelper] Parsed LLM response:", parsed)
      return parsed
    } catch (error) {
      console.error("[LLMHelper] Error in generateSolution:", error);
      throw error;
    }
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]) {
    try {
      const imageParts = await Promise.all(debugImagePaths.map(path => this.fileToGenerativePart(path)))
      
      const prompt = `${this.systemPrompt}\n\nYou are a wingman. Given:\n1. The original problem or situation: ${JSON.stringify(problemInfo, null, 2)}\n2. The current response or approach: ${currentCode}\n3. The debug information in the provided images\n\nPlease analyze the debug information and provide feedback in this JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      if (!this.useOllama && !this.model) {
        throw new Error("LLM not configured: Neither Ollama nor Gemini is active");
      }

      if (this.useOllama) {
        const images = await Promise.all(debugImagePaths.map(async (path) => {
          const data = await fs.promises.readFile(path);
          return data.toString('base64');
        }));
        const responseText = await this.callOllama(prompt, images);
        const text = this.cleanJsonResponse(responseText);
        const parsed = JSON.parse(text);
        console.log("[LLMHelper] Parsed debug LLM response:", parsed);
        return parsed;
      }

      const result = await this.model.generateContent([prompt, ...imageParts])
      const response = await result.response
      const text = this.cleanJsonResponse(response.text())
      const parsed = JSON.parse(text)
      console.log("[LLMHelper] Parsed debug LLM response:", parsed)
      return parsed
    } catch (error) {
      console.error("Error debugging solution with images:", error)
      throw error
    }
  }

  public async analyzeAudioFile(audioPath: string) {
    try {
      const audioData = await fs.promises.readFile(audioPath);
      const audioPart = {
        inlineData: {
          data: audioData.toString("base64"),
          mimeType: "audio/mp3"
        }
      };
      const prompt = `${this.systemPrompt}\n\nDescribe this audio clip in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the audio. Do not return a structured JSON object, just answer naturally as you would to a user.`;
      
      if (!this.useOllama && !this.model) {
        throw new Error("LLM not configured: Neither Ollama nor Gemini is active");
      }

      if (this.useOllama) {
        console.warn("[LLMHelper] Ollama audio analysis not fully supported. Sending text prompt only.");
        const responseText = await this.callOllama(prompt);
        return { text: responseText, timestamp: Date.now() };
      }

      const result = await this.model.generateContent([prompt, audioPart]);
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
          mimeType
        }
      };
      const prompt = `${this.systemPrompt}\n\nDescribe this audio clip in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the audio. Do not return a structured JSON object, just answer naturally as you would to a user and be concise.`;
      
      if (!this.useOllama && !this.model) {
        throw new Error("LLM not configured: Neither Ollama nor Gemini is active");
      }

      if (this.useOllama) {
        console.warn("[LLMHelper] Ollama audio analysis not fully supported. Sending text prompt only.");
        const responseText = await this.callOllama(prompt);
        return { text: responseText, timestamp: Date.now() };
      }

      const result = await this.model.generateContent([prompt, audioPart]);
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
          mimeType: "image/png"
        }
      };
      const prompt = `${this.systemPrompt}\n\nDescribe the content of this image in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the image. Do not return a structured JSON object, just answer naturally as you would to a user. Be concise and brief.`;
      
      if (!this.useOllama && !this.model) {
        throw new Error("LLM not configured: Neither Ollama nor Gemini is active");
      }

      if (this.useOllama) {
        const base64Image = imageData.toString("base64");
        const responseText = await this.callOllama(prompt, [base64Image]);
        return { text: responseText, timestamp: Date.now() };
      }

      const result = await this.model.generateContent([prompt, imagePart]);
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
          mimeType: "image/png"
        }
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

Important: Return ONLY the JSON object, no markdown formatting or code blocks.`;

      console.log("[LLMHelper] Extracting and classifying problem from image...");
      
      let classificationText: string;
      
      if (this.useOllama) {
        // Use Ollama with vision model (llava, bakllava, etc.)
        const imageBase64 = imageData.toString("base64");
        const ollamaResponse = await this.callOllama(classificationPrompt, [imageBase64]);
        classificationText = this.cleanJsonResponse(ollamaResponse);
      } else {
        // Use Gemini for vision
        if (!this.model) {
          throw new Error("Vision model (Gemini) required for image problem solving. Please configure GEMINI_API_KEY.");
        }
        const classificationResult = await this.model.generateContent([classificationPrompt, imagePart]);
        const classificationResponse = await classificationResult.response;
        classificationText = this.cleanJsonResponse(classificationResponse.text());
      }
      
      let problemData;
      try {
        problemData = JSON.parse(classificationText);
      } catch (parseError) {
        console.warn("[LLMHelper] Failed to parse classification response as JSON, using fallback:", classificationText);
        // Fallback: treat as general problem using the raw text
        problemData = {
          problem_type: "general",
          problem_statement: classificationText.substring(0, 2000), // Limit length
          code_snippet: null,
          options: null,
          constraints: [],
          examples: []
        };
      }

      console.log("[LLMHelper] Problem classified as:", problemData.problem_type);

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

Important: The code must be complete, correct, and executable C# code. Return ONLY the JSON object.`;

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

Important: Return ONLY the JSON object.`;

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

Important: Return ONLY the JSON object.`;
      }

      console.log("[LLMHelper] Generating solution with image context...");
      
      let solutionText: string;
      
      if (this.useOllama) {
        // Use Ollama with vision model for solution generation
        const imageBase64 = imageData.toString("base64");
        const ollamaResponse = await this.callOllama(solutionPrompt, [imageBase64]);
        solutionText = this.cleanJsonResponse(ollamaResponse);
      } else {
        // CRITICAL FIX: Pass the imagePart again so the solver sees the indentation/diagrams/context
        const solutionResult = await this.model!.generateContent([solutionPrompt, imagePart]);
        const solutionResponse = await solutionResult.response;
        solutionText = this.cleanJsonResponse(solutionResponse.text());
      }
      
      let solutionData;
      try {
        solutionData = JSON.parse(solutionText);
      } catch (parseError) {
        console.error("[LLMHelper] Failed to parse solution response:", solutionText);
        // Return a fallback structure with the raw text
        solutionData = {
          solution: {
            code: solutionText,
            problem_statement: problemData.problem_statement,
            thoughts: ["Solution generated but could not be parsed as JSON"],
            time_complexity: "N/A",
            space_complexity: "N/A"
          }
        };
      }

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
          input_format: { description: "Extracted from image", parameters: [] as Array<{name: string, type: string}> },
          output_format: { description: "Generated solution", type: "string", subtype: "code" },
          complexity: {
            time: solutionData.solution?.time_complexity || "N/A",
            space: solutionData.solution?.space_complexity || "N/A"
          },
          test_cases: [] as Array<{input: string, output: string}>,
          validation_type: "auto",
          difficulty: "extracted"
        },
        solution: solutionData.solution,
        timestamp: Date.now()
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
      } else if (this.model) {
        const result = await this.model.generateContent(message);
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
      if (!response.ok) throw new Error('Failed to fetch models');
      
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
    return this.useOllama ? this.ollamaModel : "gemini-2.0-flash";
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
    
    console.log(`[LLMHelper] Switched to Ollama: ${this.ollamaModel} at ${this.ollamaUrl}`);
  }

  public async switchToGemini(apiKey?: string): Promise<void> {
    if (apiKey) {
      const genAI = new GoogleGenerativeAI(apiKey);
      this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    }
    
    if (!this.model && !apiKey) {
      throw new Error("No Gemini API key provided and no existing model instance");
    }
    
    this.useOllama = false;
    console.log("[LLMHelper] Switched to Gemini");
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.useOllama) {
        const available = await this.checkOllamaAvailable();
        if (!available) {
          return { success: false, error: `Ollama not available at ${this.ollamaUrl}` };
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

import { LLMHelper } from "../electron/LLMHelper";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

async function verifyFix() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("No GEMINI_API_KEY found in .env");
    process.exit(1);
  }

  const llmHelper = new LLMHelper(apiKey, false); // Force Gemini
  const imagePath = path.join(__dirname, "..", "screenshots", "04926d8d-b324-4309-a1de-37720c16d3a1.png");

  console.log("Testing with image:", imagePath);

  try {
    const result = await llmHelper.solveImageProblem(imagePath);
    console.log("---------------------------------------------------");
    console.log("Problem Type:", result.problemInfo.problem_type);
    console.log("Statement:", result.problemInfo.problem_statement);
    console.log("---------------------------------------------------");
    console.log("Solution Code:");
    console.log(result.solution.code);
    console.log("---------------------------------------------------");
    
    // Check if result contains Python code (heuristic validation)
    if (result.solution.code.includes("def ") || result.solution.code.includes("import ") || result.solution.code.includes("print(")) {
        console.log("SUCCESS: Detected Python-like code in solution.");
    } else if (result.problemInfo.problem_type === "mcq") {
        console.log("SUCCESS: MCQ answer generated.");
    } else {
        console.warn("WARNING: Solution might not be code. Please inspect manual output.");
    }

  } catch (error) {
    console.error("Verification failed:", error);
  }
}

verifyFix();

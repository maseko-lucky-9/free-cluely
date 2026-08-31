# Fix Image Problem Solving

## Goal

Fix the application so it properly extracts problem statements from images and solves them, instead of just describing them.

## Context

- **Current Behavior**: System describes images (coding challenges/MCQs) but doesn't solve them.
- **Desired Behavior**:
  - **Coding Challenge**: Write complete, executable code.
  - **MCQ**: Provide correct answer with reasoning.
- **Architecture**: The user prompt mentions "Python codebase", but the project is primarily TypeScript (Electron/React). Use judgment: if no Python codebase exists, apply fixes to the TypeScript codebase (`LLMHelper.ts`), or create Python execution scripts if it fits the Beast architecture.

## Steps

1. **Understand**:
   - Map current image processing pipeline.
   - debug `LLMHelper.ts` (specifically `solveImageProblem` vs `analyzeImageFile`).
   - Identify why flow breaks between description and solving.
2. **Design**:
   - Improve Prompt Engineering in `LLMHelper.ts`.
   - Ensure `solveImageProblem` is actually called (check `ipcHandlers.ts` or where it's invoked).
   - Verify Output Format.
3. **Implement**:
   - Modify `LLMHelper.ts` or relevant files.
   - Add proper error handling.
   - Maintain compatibility.

## Tools

- `LLMHelper.ts`: Main logic file.
- `execution/`: Create test scripts here (Python or TS).

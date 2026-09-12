// Payload shape for the DEBUG_SUCCESS event.
//
// No electron import - keep it that way so this stays unit-testable from plain node.
//
// The debug view diffs a previous solution against an improved one, so it reads
// `old_code` and `new_code`. The LLM schema produces neither: it returns
// { code, language, explanation, thoughts, time_complexity, space_complexity }.
// Those two fields were a leftover from the Gemini-era contract and were never
// supplied, so the view's `!oldCode || !newCode` gate stayed true forever and the
// section skeletoned permanently. Both values are already known at the call site;
// this just puts them where the view looks.

export interface DebugSolution {
  code?: string;
  language?: string;
  explanation?: string;
  thoughts?: string[];
  time_complexity?: string;
  space_complexity?: string;
  [key: string]: unknown;
}

export interface DebugPayload {
  solution: DebugSolution & {
    old_code: string | null;
    new_code: string | null;
  };
}

/**
 * @param previousCode the solution being improved, or null when the debug run
 *        had no prior solution to compare against (a fresh extra screenshot).
 */
export function buildDebugPayload(
  previousCode: string | null,
  solution: DebugSolution | null | undefined,
): DebugPayload {
  const resolved: DebugSolution = solution ?? {};
  return {
    solution: {
      ...resolved,
      old_code: previousCode ?? null,
      new_code: resolved.code ?? null,
    },
  };
}

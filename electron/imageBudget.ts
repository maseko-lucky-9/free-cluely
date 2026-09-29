// Decides whether a capture should be downscaled before it is sent to the model.
//
// No electron import - keep it that way so this stays unit-testable from plain node.
//
// Measured on this machine (qwen3.5:9b, Ollama 0.33): a 3024x1964 Retina capture
// costs 4056 image tokens and ~15 s of prompt-eval per call; the same screen at
// its logical 1512 px costs 1484 tokens / ~3 s and still reads correctly. But a
// 1x external display (3440x1440 @72dpi) has no spare detail to throw away, so
// the rule is: shrink to logical 1x, never below it, never guess.

export interface DisplayInfo {
  /** Logical (point) size. */
  width: number;
  height: number;
  scaleFactor: number;
}

/**
 * Returns the width to downscale a capture to, or null to leave it alone.
 * The capture is matched to the display that produced it by pixel size; an
 * unmatched capture is left untouched rather than resized on a guess.
 */
export function downscaleWidth(
  pixelWidth: number,
  pixelHeight: number,
  displays: DisplayInfo[],
): number | null {
  const source = displays.find(
    (d) =>
      Math.round(d.width * d.scaleFactor) === pixelWidth &&
      Math.round(d.height * d.scaleFactor) === pixelHeight,
  );
  if (!source || source.scaleFactor <= 1) return null;
  return Math.round(source.width);
}

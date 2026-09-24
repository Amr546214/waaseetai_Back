// Centralized Gemini model configuration. Feature services must read model
// names from here, never hardcode a Gemini model string of their own — this
// is the single place a model gets swapped/upgraded later.
//
// Defaults are intentionally generic (not tuned per product feature yet):
// `gemini-flash-latest` is a single multimodal-capable model suitable for
// text, structured JSON, streaming, and (later) vision, so one default can
// safely cover all three purposes until a feature-specific need justifies
// overriding it.

export interface GeminiModelConfig {
  /** Standard (non-streamed) text / structured-JSON generation. */
  textModel: string;
  /** Streaming text generation. */
  streamingModel: string;
  /** Vision-capable generation (image understanding). Not wired to any
   *  feature yet — reserved for the Batch D vision migration. */
  visionModel: string;
}

const DEFAULT_MODEL = 'gemini-flash-latest';

export const geminiModelConfig: GeminiModelConfig = {
  textModel: process.env.GEMINI_TEXT_MODEL || DEFAULT_MODEL,
  streamingModel: process.env.GEMINI_STREAMING_MODEL || DEFAULT_MODEL,
  visionModel: process.env.GEMINI_VISION_MODEL || DEFAULT_MODEL,
};

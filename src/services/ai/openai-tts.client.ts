import OpenAI from 'openai';

// F8-TTS — deliberately NOT migrated to Gemini in this batch (see the
// Gemini migration report's F8-TTS contract for why: the installed
// @google/genai SDK typings do not document the exact output sample
// rate/channel/bit-depth contract for a standard generateContent
// audio-modality response, and fabricating those values to build a WAV
// wrapper would risk silently-corrupt audio in production). Isolated into
// its own thin module — mirroring how geminiClient centralizes the Gemini
// SDK — purely so it can be swapped/removed independently of the rest of
// the avatar chat gateway, and mocked by relative path in tests instead of
// mocking the `openai` package specifier directly.

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 15 * 1000,
  maxRetries: 0,
});

export function isOpenAiTtsConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dummy_key';
}

/** Returns base64-encoded MP3 audio for `text`, or throws on any provider failure. */
export async function generateSpeechMp3Base64(text: string): Promise<string> {
  const mp3Response = await openai.audio.speech.create({
    model: 'tts-1-hd',
    voice: 'onyx',
    response_format: 'mp3',
    input: text,
  });
  const buffer = Buffer.from(await mp3Response.arrayBuffer());
  return buffer.toString('base64');
}

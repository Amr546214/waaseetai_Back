// F8-TTS adapter (see the Gemini migration report's F8-TTS contract).
//
// A standalone, application-owned utility that wraps raw PCM audio bytes in
// a minimal, valid RIFF/WAVE header so a browser <audio> element can play
// them directly (browsers cannot play bare PCM without a container). This
// is deliberately generic and takes the sample rate/channel count/bit depth
// as EXPLICIT parameters — it never assumes or hardcodes a specific
// provider's audio format. That is intentional: this batch does not yet
// wire a live Gemini TTS call into any handler, because the locally
// installed @google/genai SDK typings do not document the exact output
// sample rate/channel/bit-depth contract for a standard generateContent
// audio-modality response (see the migration report). Inventing those
// values here would risk silently constructing corrupt/inaudible files.
// This adapter exists so that, once a real Gemini TTS call is live-tested
// and its actual response metadata is confirmed, wiring it up is a matter
// of passing the real values through — not writing new binary-format code
// under time pressure.

export interface PcmFormat {
  sampleRateHz: number;
  channels: number;
  bitsPerSample: number;
}

const RIFF_HEADER_SIZE = 44; // 12 (RIFF chunk) + 24 (fmt chunk) + 8 (data chunk header)

/**
 * Wraps raw little-endian PCM sample data in a canonical 44-byte RIFF/WAVE
 * header. Returns a single Buffer: header followed immediately by the PCM
 * payload, ready to be served as `audio/wav`.
 */
export function pcmToWav(pcmData: Buffer, format: PcmFormat): Buffer {
  const { sampleRateHz, channels, bitsPerSample } = format;

  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error(`pcmToWav: invalid sampleRateHz (${sampleRateHz})`);
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new Error(`pcmToWav: invalid channels (${channels})`);
  }
  if (!Number.isInteger(bitsPerSample) || bitsPerSample <= 0 || bitsPerSample % 8 !== 0) {
    throw new Error(`pcmToWav: invalid bitsPerSample (${bitsPerSample})`);
  }
  if (!Buffer.isBuffer(pcmData) || pcmData.length === 0) {
    throw new Error('pcmToWav: pcmData must be a non-empty Buffer');
  }

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRateHz * blockAlign;
  const dataSize = pcmData.length;

  const header = Buffer.alloc(RIFF_HEADER_SIZE);
  let offset = 0;

  header.write('RIFF', offset, 'ascii'); offset += 4;
  header.writeUInt32LE(36 + dataSize, offset); offset += 4; // ChunkSize
  header.write('WAVE', offset, 'ascii'); offset += 4;

  header.write('fmt ', offset, 'ascii'); offset += 4;
  header.writeUInt32LE(16, offset); offset += 4; // Subchunk1Size (PCM)
  header.writeUInt16LE(1, offset); offset += 2; // AudioFormat = 1 (PCM, uncompressed)
  header.writeUInt16LE(channels, offset); offset += 2;
  header.writeUInt32LE(sampleRateHz, offset); offset += 4;
  header.writeUInt32LE(byteRate, offset); offset += 4;
  header.writeUInt16LE(blockAlign, offset); offset += 2;
  header.writeUInt16LE(bitsPerSample, offset); offset += 2;

  header.write('data', offset, 'ascii'); offset += 4;
  header.writeUInt32LE(dataSize, offset); offset += 4;

  return Buffer.concat([header, pcmData]);
}

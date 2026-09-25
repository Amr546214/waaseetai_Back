import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav } from './pcm-to-wav';

// F8-TTS adapter — pure binary-format tests, zero Gemini/OpenAI dependency.
// This is the part of F8-TTS that IS fully provable without a live provider
// call: given explicit sample rate/channels/bit depth and raw PCM bytes,
// the resulting file must be byte-for-byte a valid, minimal RIFF/WAVE
// container a browser can play. What remains impossible to prove without a
// real Gemini call is documented in the migration report (whether Gemini's
// actual response truly is raw PCM at these parameters at all).

function samplePcm(byteLength = 8): Buffer {
  const buf = Buffer.alloc(byteLength);
  for (let i = 0; i < byteLength; i++) buf[i] = i + 1;
  return buf;
}

test('pcmToWav: RIFF header — starts with "RIFF" and correct little-endian ChunkSize (36 + data length)', () => {
  const pcm = samplePcm(100);
  const wav = pcmToWav(pcm, { sampleRateHz: 24000, channels: 1, bitsPerSample: 16 });

  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
});

test('pcmToWav: WAVE marker is present at bytes 8-11', () => {
  const wav = pcmToWav(samplePcm(), { sampleRateHz: 16000, channels: 1, bitsPerSample: 16 });
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
});

test('pcmToWav: fmt chunk — id, size 16, PCM format code 1, and the exact provided channels/sampleRate/bitsPerSample', () => {
  const wav = pcmToWav(samplePcm(), { sampleRateHz: 24000, channels: 2, bitsPerSample: 16 });

  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt32LE(16), 16, 'Subchunk1Size must be 16 for PCM');
  assert.equal(wav.readUInt16LE(20), 1, 'AudioFormat must be 1 (uncompressed PCM)');
  assert.equal(wav.readUInt16LE(22), 2, 'NumChannels must match the provided value exactly');
  assert.equal(wav.readUInt32LE(24), 24000, 'SampleRate must match the provided value exactly');
  const expectedByteRate = 24000 * 2 * (16 / 8);
  assert.equal(wav.readUInt32LE(28), expectedByteRate, 'ByteRate must be computed from the real sampleRate/channels/bitsPerSample');
  const expectedBlockAlign = 2 * (16 / 8);
  assert.equal(wav.readUInt16LE(32), expectedBlockAlign);
  assert.equal(wav.readUInt16LE(34), 16, 'BitsPerSample must match the provided value exactly');
});

test('pcmToWav: data chunk — id, correct payload length, and the exact original PCM bytes appended unmodified', () => {
  const pcm = samplePcm(64);
  const wav = pcmToWav(pcm, { sampleRateHz: 8000, channels: 1, bitsPerSample: 8 });

  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, 44 + pcm.length, 'total file length must be exactly header + payload');
  assert.deepEqual(wav.subarray(44), pcm, 'the PCM payload must be copied through byte-for-byte, never altered');
});

test('pcmToWav: never invents audio metadata — uses exactly the sampleRate/channels/bitsPerSample the caller provided, for multiple distinct real-world formats', () => {
  const cases: Array<{ sampleRateHz: number; channels: number; bitsPerSample: number }> = [
    { sampleRateHz: 8000, channels: 1, bitsPerSample: 8 },
    { sampleRateHz: 16000, channels: 1, bitsPerSample: 16 },
    { sampleRateHz: 44100, channels: 2, bitsPerSample: 16 },
    { sampleRateHz: 48000, channels: 2, bitsPerSample: 24 }
  ];

  for (const format of cases) {
    const wav = pcmToWav(samplePcm(32), format);
    assert.equal(wav.readUInt32LE(24), format.sampleRateHz);
    assert.equal(wav.readUInt16LE(22), format.channels);
    assert.equal(wav.readUInt16LE(34), format.bitsPerSample);
  }
});

test('pcmToWav: rejects an empty PCM buffer instead of producing a hollow/invalid file', () => {
  assert.throws(() => pcmToWav(Buffer.alloc(0), { sampleRateHz: 24000, channels: 1, bitsPerSample: 16 }));
});

test('pcmToWav: rejects a non-positive or non-integer sample rate', () => {
  assert.throws(() => pcmToWav(samplePcm(), { sampleRateHz: 0, channels: 1, bitsPerSample: 16 }));
  assert.throws(() => pcmToWav(samplePcm(), { sampleRateHz: -24000, channels: 1, bitsPerSample: 16 }));
  assert.throws(() => pcmToWav(samplePcm(), { sampleRateHz: 24000.5, channels: 1, bitsPerSample: 16 }));
});

test('pcmToWav: rejects a non-positive channel count', () => {
  assert.throws(() => pcmToWav(samplePcm(), { sampleRateHz: 24000, channels: 0, bitsPerSample: 16 }));
});

test('pcmToWav: rejects a bit depth that is not a positive multiple of 8', () => {
  assert.throws(() => pcmToWav(samplePcm(), { sampleRateHz: 24000, channels: 1, bitsPerSample: 0 }));
  assert.throws(() => pcmToWav(samplePcm(), { sampleRateHz: 24000, channels: 1, bitsPerSample: 12 }));
});

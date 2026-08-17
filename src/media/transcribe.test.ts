import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachTranscripts, asrFileId, transcodeToPcm, transcribeVoice } from './transcribe';

const ffmpegAvailable = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const describeFfmpeg = ffmpegAvailable ? describe : describe.skip;

let dir: string;
let opusPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcribe-test-'));
  opusPath = join(dir, 'voice.opus');
  if (ffmpegAvailable) {
    execFileSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '16000', '-ac', '1', '-c:a', 'libopus', opusPath],
    );
  }
});

afterAll(() => {
  execFileSync('rm', ['-rf', dir]);
});

describe('asrFileId', () => {
  it('returns a 16-char alphanumeric/underscore id', () => {
    const id = asrFileId();
    expect(id).toMatch(/^[a-zA-Z0-9_]{16}$/);
  });

  it('is unique across calls', () => {
    expect(asrFileId()).not.toBe(asrFileId());
  });
});

describeFfmpeg('transcodeToPcm', () => {
  it('decodes opus to 16k mono s16le pcm', async () => {
    const pcm = await transcodeToPcm(opusPath);
    // 1s × 16000 samples/s × 2 bytes = 32000 bytes.
    expect(pcm.length).toBe(32000);
  });

  it('rejects when the file is not audio', async () => {
    const junk = join(dir, 'junk.bin');
    writeFileSync(junk, 'this is not audio data, definitely not');
    await expect(transcodeToPcm(junk)).rejects.toThrow();
  });
});

describe('transcribeVoice', () => {
  it('returns ok:false without throwing when ffmpeg fails', async () => {
    const junk = join(dir, 'junk2.bin');
    writeFileSync(junk, 'not audio');
    const res = await transcribeVoice({} as never, junk);
    expect(res.ok).toBe(false);
    expect(res.text).toBe('');
  });
});

describe('attachTranscripts', () => {
  type TA = { kind: string; path: string; transcript?: string };

  it('skips non-audio attachments', async () => {
    const attachments: TA[] = [
      { kind: 'image', path: '/x.png' },
      { kind: 'file', path: '/y.pdf' },
    ];
    await attachTranscripts({} as never, attachments);
    expect(attachments[0]!.transcript).toBeUndefined();
    expect(attachments[1]!.transcript).toBeUndefined();
  });

  it('leaves audio attachments without transcript on failure', async () => {
    const junk = join(dir, 'junk3.bin');
    writeFileSync(junk, 'not audio');
    const attachments: TA[] = [{ kind: 'audio', path: junk }];
    await attachTranscripts({} as never, attachments);
    expect(attachments[0]!.transcript).toBeUndefined();
  });
});

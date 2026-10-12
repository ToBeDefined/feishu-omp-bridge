import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachTranscripts, asrFileId, mediaFailureNotice, transcodeToPcm, transcribeVoice } from './transcribe';

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
let videoPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcribe-test-'));
  opusPath = join(dir, 'voice.opus');
  videoPath = join(dir, 'clip.mp4');
  if (ffmpegAvailable) {
    execFileSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '16000', '-ac', '1', '-c:a', 'libopus', opusPath],
    );
    // Video with a 1s sine audio track — the exact container the bridge
    // downloads from Feishu.
    execFileSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', videoPath],
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

  it('extracts the audio track from a video container to 16k pcm', async () => {
    const pcm = await transcodeToPcm(videoPath);
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

  it('attempts video attachments but degrades gracefully on failure', async () => {
    const junk = join(dir, 'junk4.bin');
    writeFileSync(junk, 'not a real video');
    const attachments: TA[] = [{ kind: 'video', path: junk }];
    await attachTranscripts({} as never, attachments);
    // Best-effort: a broken file must not throw or block the caller.
    expect(attachments[0]!.transcript).toBeUndefined();
  });

  it('向上返回失败项（带 reason），非音视频不产生失败', async () => {
    const junk = join(dir, 'junk5.bin');
    writeFileSync(junk, 'not audio');
    const failures = await attachTranscripts({} as never, [{ kind: 'audio', path: junk }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'audio', path: junk });
    expect(failures[0]!.reason).toBeTruthy();

    expect(await attachTranscripts({} as never, [{ kind: 'image', path: '/x.png' }])).toEqual([]);
    expect(await attachTranscripts({} as never, [])).toEqual([]);
  });
});

describe('mediaFailureNotice', () => {
  it('全空返回 undefined —— 成功的语音不打扰用户', () => {
    expect(mediaFailureNotice({})).toBeUndefined();
    expect(mediaFailureNotice({ transcriptFailures: [], unresolvedDownloads: 0 })).toBeUndefined();
  });

  it('转写失败给一条轻量提示', () => {
    const notice = mediaFailureNotice({
      transcriptFailures: [{ kind: 'audio', path: '/a.opus', reason: '音频转码失败' }],
    });
    expect(notice).toContain('转写失败');
    expect(notice).toContain('已忽略');
  });

  it('转写失败与下载失败各占一行', () => {
    const notice = mediaFailureNotice({
      transcriptFailures: [{ kind: 'video', path: '/v.mp4', reason: '识别失败（1）' }],
      unresolvedDownloads: 2,
    });
    expect(notice).toContain('转写失败');
    expect(notice).toContain('附件下载失败');
  });
});

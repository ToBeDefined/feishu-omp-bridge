import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * Voice message → text via Feishu ASR (`speech_to_text.v1.speech.fileRecognize`).
 *
 * Feishu voice messages download as opus/amr/silk; the ASR endpoint only
 * accepts 16 kHz mono s16le PCM, so the audio must be transcoded first
 * (ffmpeg). The whole file is recognized in one shot; voices are short
 * (≤60s) so this fits file_recognize's limits.
 *
 * Requirements (fail soft — transcription is best-effort, never blocks the
 * chat):
 *   - ffmpeg on PATH (brew install ffmpeg)
 *   - app scope `speech_to_text:speech` enabled in the Feishu console
 */
export interface TranscriptionResult {
  /** Recognized text (trimmed). Empty string = nothing recognized. */
  text: string;
  /** Set when the whole pipeline (transcode+ASR) succeeded. */
  ok: boolean;
}

const PCM_SAMPLE_RATE = 16_000;

/** Transcode audio file → raw s16le PCM via ffmpeg (16k mono). */
export function transcodeToPcm(audioPath: string, timeoutMs = 30_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', audioPath,
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ar', String(PCM_SAMPLE_RATE),
      '-ac', '1',
      'pipe:1',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => stderr.push(c));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(stderr).toString().slice(0, 300)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg transcoding timed out'));
    }, timeoutMs);
    proc.on('close', () => clearTimeout(timer));
  });
}

/** 16-char [a-zA-Z0-9_] identifier the ASR API requires per file. */
export function asrFileId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Transcribe a downloaded voice file. Best-effort: any failure logs and
 * returns `{ ok: false, text: '' }` rather than throwing — a broken voice
 * pipeline must not block the chat.
 */
export async function transcribeVoice(
  channel: LarkChannel,
  audioPath: string,
  timeoutMs = 30_000,
): Promise<TranscriptionResult> {
  let pcm: Buffer;
  try {
    pcm = await transcodeToPcm(audioPath, timeoutMs);
  } catch (err) {
    log.warn('transcribe', 'transcode-failed', {
      audioPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, text: '' };
  }
  if (pcm.length === 0) {
    log.warn('transcribe', 'empty-pcm', { audioPath });
    return { ok: false, text: '' };
  }

  try {
    const speech = pcm.toString('base64');
    const res = await channel.rawClient.speech_to_text.v1.speech.fileRecognize({
      data: {
        speech: { speech },
        config: { file_id: asrFileId(), format: 'pcm', engine_type: '16k_auto' },
      },
    });
    if (res.code !== 0) {
      log.warn('transcribe', 'asr-failed', { code: res.code, msg: res.msg, audioPath });
      return { ok: false, text: '' };
    }
    const text = (res.data?.recognition_text ?? '').trim();
    log.info('transcribe', 'ok', { audioPath, chars: text.length });
    return { ok: true, text };
  } catch (err) {
    log.warn('transcribe', 'asr-error', {
      audioPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, text: '' };
  }
}

/** Read an audio file's raw bytes (for tests / diagnostics). */
export async function readAudioFile(path: string): Promise<Buffer> {
  return readFile(path);
}

/**
 * Transcribe every audio attachment in place (mutates `attachments` by
 * setting `.transcript`). Best-effort — a failed transcription leaves the
 * attachment without a transcript and never blocks the caller.
 */
export async function attachTranscripts(
  channel: LarkChannel,
  attachments: { kind: string; path: string; transcript?: string }[],
): Promise<void> {
  for (const a of attachments) {
    if (a.kind !== 'audio') continue;
    const r = await transcribeVoice(channel, a.path);
    if (r.ok && r.text) a.transcript = r.text;
  }
}

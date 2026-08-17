import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { paths } from '../config/paths';
import { MediaCache } from './cache';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'media-cache-test-'));
  vi.spyOn(paths, 'mediaDir', 'get').mockReturnValue(dir);
});

afterAll(() => {
  vi.restoreAllMocks();
});

function makeChannel() {
  const writeFile = vi.fn(async () => undefined);
  const get = vi.fn(async () => ({ writeFile }));
  const rawClient = { im: { v1: { messageResource: { get } } } };
  const channel = { rawClient } as never;
  return { channel, get, writeFile };
}

describe('MediaCache.resolve', () => {
  it('downloads audio with type=file (not type=audio → 400)', async () => {
    const { channel, get } = makeChannel();
    const cache = new MediaCache(channel);
    const attachments = await cache.resolve('oc_test', [
      { messageId: 'om_1', resource: { type: 'audio', fileKey: 'audio_key_1', fileName: 'voice.ogg' } },
    ]);
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ params: { type: 'file' }, path: { message_id: 'om_1', file_key: 'audio_key_1' } }),
    );
    expect(attachments[0]!.kind).toBe('audio');
    expect(attachments[0]!.path).toContain('audio_key_1');
  });

  it('downloads video with type=file', async () => {
    const { channel, get } = makeChannel();
    const cache = new MediaCache(channel);
    await cache.resolve('oc_test', [
      { messageId: 'om_2', resource: { type: 'video', fileKey: 'video_key_1', fileName: 'clip.mp4' } },
    ]);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ params: { type: 'file' } }));
  });

  it('downloads image with type=image', async () => {
    const { channel, get } = makeChannel();
    const cache = new MediaCache(channel);
    await cache.resolve('oc_test', [
      { messageId: 'om_3', resource: { type: 'image', fileKey: 'img_key_1', fileName: 'pic.png' } },
    ]);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ params: { type: 'image' } }));
  });

  it('skips stickers', async () => {
    const { channel, get } = makeChannel();
    const cache = new MediaCache(channel);
    const attachments = await cache.resolve('oc_test', [
      { messageId: 'om_4', resource: { type: 'sticker', fileKey: 'sticker_key_1' } },
    ]);
    expect(attachments).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});

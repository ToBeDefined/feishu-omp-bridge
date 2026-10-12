import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { paths } from '../../config/paths';
import { NON_CHAT_ALLOWLIST_ENV, commonOmpModels, isChatModel, loadModelData } from './data';
import type { ModelsCache } from './data';

let dir: string;
let cacheFile: string;
let fakeOmp: string;
// Fake omp reads this file to decide which model list to serve, letting the
// test flip the "remote" list between two loads.
let serveFile: string;
// Served for `omp config get modelRoles --json`.
let rolesFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-data-test-'));
  cacheFile = join(dir, 'models-cache.json');
  serveFile = join(dir, 'serve.json');
  rolesFile = join(dir, 'roles.json');
  fakeOmp = join(dir, 'fake-omp.sh');
  writeFileSync(fakeOmp, [
    '#!/bin/bash',
    'if [[ "$1" == "models" ]]; then cat "$(dirname "$0")/serve.json"; exit 0; fi',
    'if [[ "$1" == "config" ]]; then cat "$(dirname "$0")/roles.json"; exit 0; fi',
    'exit 1',
  ].join('\n'));
  chmodSync(fakeOmp, 0o755);
  writeFileSync(rolesFile, JSON.stringify({ value: {} }));
  vi.spyOn(paths, 'modelsCacheFile', 'get').mockReturnValue(cacheFile);
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('loadModelData', () => {
  it('force refresh rewrites the disk cache (regression: refresh left stale cache)', async () => {
    // Built here, not at module scope: fakeOmp is only assigned in beforeAll.
    const cfg = { preferences: { ompBinary: fakeOmp } } as never;

    // v1 list served → force refresh → must persist v1 to disk.
    writeFileSync(serveFile, JSON.stringify({ models: [{ provider: 'p1', selector: 'p1/v1' }] }));
    const first = await loadModelData(cfg, true);
    expect(first.list).toHaveLength(1);
    const onDisk = JSON.parse(readFileSync(cacheFile, 'utf8')) as ModelsCache;
    expect(onDisk.list[0]!.selector).toBe('p1/v1');

    // Remote now serves v2; force refresh must persist it so a later
    // non-force load (within TTL) sees v2, not the stale v1.
    writeFileSync(serveFile, JSON.stringify({ models: [{ provider: 'p1', selector: 'p1/v2' }] }));
    await loadModelData(cfg, true);
    const cached = await loadModelData(cfg, false);
    expect(cached.list[0]!.selector).toBe('p1/v2');
  });
});

describe('commonOmpModels', () => {
  it('offers chat roles and drops the non-chat kind roles', async () => {
    const cfg = { preferences: { ompBinary: fakeOmp } } as never;
    writeFileSync(
      rolesFile,
      JSON.stringify({
        value: {
          default: 'p1/chat:high',
          smol: 'p1/chat:low',
          vision: 'p1/vision',
          memory: 'p1/memory',
          image: 'p1/gpt-image-1',
          web: 'p1/gemini-search',
          speech: 'p1/tts-1',
          dictation: 'p1/whisper-1',
          judge: 'p1/judge-1',
          bare: 'no-provider',
        },
      }),
    );
    // Only chat-capable roles reach the quick-set buttons: pointing `omp
    // --model` at a TTS/search/image model fails every run in that chat.
    expect(await commonOmpModels(cfg)).toEqual(['p1/chat', 'p1/vision', 'p1/memory']);
  });
});

/** 真实缓存形状（`omp models --json`）—— 注意 kind 全是 "chat"，过滤只能看 id。 */
const realEntry = (
  provider: string,
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  provider,
  kind: 'chat',
  id,
  selector: `${provider}/${id}`,
  name: id,
  contextWindow: 200000,
  maxTokens: 64000,
  reasoning: true,
  thinking: ['low', 'high', 'max'],
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...extra,
});

describe('非对话模型过滤', () => {
  // cfg 只能在 it 里建：fakeOmp 是 beforeAll 才赋值的（describe 体在收集阶段就跑了）。
  // 本机 futu 提供的 19 条非对话模型 + whisper，外加两条真对话模型。
  const served = [
    realEntry('futu', 'deepseek-v4.1-flash'),
    realEntry('futu', 'azure-speech', { thinking: [] }),
    realEntry('futu', 'gpt-image-2'),
    realEntry('futu', 'gemini-3-pro-image-preview'),
    realEntry('futu', 'qwen-vl-ocr'),
    realEntry('futu', 'qwen3-tts-flash'),
    realEntry('futu', 'qwen3-vl-plus'),
    realEntry('futu', 'text-embedding-3-large'),
    realEntry('futu', 'volcsearch-web-search'),
    realEntry('futu', 'whisper'),
    realEntry('cursor', 'claude-4-sonnet'),
  ];

  it('drops non-chat models from the picker list (kind:"chat" is on every entry)', async () => {
    writeFileSync(serveFile, JSON.stringify({ models: served }));
    writeFileSync(rolesFile, JSON.stringify({ value: { default: 'futu/deepseek-v4.1-flash' } }));
    const data = await loadModelData({ preferences: { ompBinary: fakeOmp } } as never, true);
    expect(data.list.map((m) => m.selector)).toEqual([
      'futu/deepseek-v4.1-flash',
      'cursor/claude-4-sonnet',
    ]);
    // 缓存里存的也是过滤后的列表（否则每次读缓存都要重滤 + 重复 log）。
    const onDisk = JSON.parse(readFileSync(cacheFile, 'utf8')) as ModelsCache;
    expect(onDisk.list.some((m) => m.selector === 'futu/text-embedding-3-large')).toBe(false);
  });

  it('filters the 常用 quick set too (a chat role pointing at a non-chat model)', async () => {
    writeFileSync(serveFile, JSON.stringify({ models: served }));
    writeFileSync(
      rolesFile,
      JSON.stringify({
        value: { default: 'futu/deepseek-v4.1-flash', smol: 'futu/text-embedding-3-large' },
      }),
    );
    const data = await loadModelData({ preferences: { ompBinary: fakeOmp } } as never, true);
    expect(data.commons).toEqual(['futu/deepseek-v4.1-flash']);
  });

  it('re-filters an old cache written before the rule existed', async () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        fetchedAt: Date.now(),
        list: [realEntry('futu', 'deepseek-v4.1-flash'), realEntry('futu', 'text-embedding-v4')],
        commons: ['futu/volcsearch_collab'],
      }),
    );
    const data = await loadModelData({ preferences: { ompBinary: fakeOmp } } as never, false);
    expect(data.list.map((m) => m.selector)).toEqual(['futu/deepseek-v4.1-flash']);
    expect(data.commons).toEqual([]);
  });

  it('keeps chat models that merely look like the blacklist patterns', () => {
    for (const sel of [
      'futu/deepseek-v4.1-flash',
      'cursor/claude-4-sonnet',
      'zhipu-coding-plan/glm-5.2',
      'volcsearch-provider/gpt-5', // provider 名里带 search 不误伤：只看 id 段
    ]) {
      expect(isChatModel(sel)).toBe(true);
    }
    for (const sel of [
      'futu/azure-speech',
      'futu/gpt-image-2',
      'futu/gemini-2.5-flash-image-preview',
      'futu/qwen-vl-ocr',
      'futu/qwen3-tts-flash',
      'futu/text-embedding-3-small',
      'futu/volcsearch-web-search',
      'futu/volcsearch_collab',
      'futu/whisper',
    ]) {
      expect(isChatModel(sel)).toBe(false);
    }
  });

  it('lets the env allowlist exempt a filtered model (escape hatch)', async () => {
    process.env[NON_CHAT_ALLOWLIST_ENV] = 'futu/qwen3-vl-plus';
    try {
      expect(isChatModel('futu/qwen3-vl-plus')).toBe(true);
      expect(isChatModel('futu/qwen3-tts-flash')).toBe(false);
      writeFileSync(
        serveFile,
        JSON.stringify({ models: [realEntry('futu', 'qwen3-vl-plus'), realEntry('futu', 'whisper')] }),
      );
      writeFileSync(rolesFile, JSON.stringify({ value: {} }));
      const data = await loadModelData({ preferences: { ompBinary: fakeOmp } } as never, true);
      expect(data.list.map((m) => m.selector)).toEqual(['futu/qwen3-vl-plus']);
    } finally {
      delete process.env[NON_CHAT_ALLOWLIST_ENV];
    }
    expect(isChatModel('futu/qwen3-vl-plus')).toBe(false);
  });
});

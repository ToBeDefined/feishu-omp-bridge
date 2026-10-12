import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../../config/paths';
import { getOmpBinary } from '../../config/schema';
import type { AppConfig } from '../../config/schema';
import { log } from '../../core/logger';

export interface OmpModelEntry {
  provider: string;
  selector: string;
  name?: string;
  /** 该模型支持的思考档位（`omp models --json` 里的 `thinking`）。空 / 缺失 =
   * 不支持思考强度。 */
  thinking?: string[];
}

const execFileAsync = promisify(execFile);

/**
 * OMP roles that hold non-chat models. OMP 18.2.7 added them (plus automatic
 * migration of legacy web-search / tts / stt settings into `modelRoles`), and
 * its own role pickers filter candidates by model kind — a `speech` selector
 * is a TTS model, `web` a search model, `image` an image generator. Offering
 * one as a quick-set would point `omp --model` at a model that cannot answer a
 * prompt, so every run in that chat would fail.
 */
const NON_CHAT_ROLES = new Set(['image', 'web', 'speech', 'dictation', 'judge']);

/**
 * 明显不能对话的模型 id 特征。
 *
 * **为什么不能靠 `kind` 过滤**：`omp models --json` 给每一条都报 `kind:"chat"`
 * （本机 2026-10 的缓存 328/328，含 `azure-speech`、`gpt-image-2`、
 * `text-embedding-3-large`、`volcsearch-web-search`），OMP 目前没有区分对话 /
 * 语音 / 图像的 kind 枚举。所以「是不是对话模型」只能从 id 形态判断。
 *
 * 命中这些特征的模型不进 `/model` 的选择器与「最近使用 / 常用」快捷区
 * （否则点一下就把 `omp --model` 指向一个答不了话的模型，那个会话的 run 全都会失败）；
 * 仍可用 `/model <完整 selector>` 或 {@link NON_CHAT_ALLOWLIST_ENV} 直接指定。
 *
 * 只匹配 id 段（`provider/model` 的 model 部分），provider 名不参与，免得误伤。
 */
const NON_CHAT_ID_PATTERNS: RegExp[] = [
  /(^|[-_])speech($|[-_])/, // azure-speech
  /(^|[-_])tts($|[-_])/, // qwen3-tts-flash(-realtime)
  /(^|[-_])stt($|[-_])/,
  /(^|[-_])whisper($|[-_])/, // 语音转写
  /(^|[-_])rerank($|[-_])/,
  /embedding/, // text-embedding-*
  /(^|[-_])image($|[-_])/, // gpt-image-2 / gemini-3-pro-image(-preview)
  /(^|[-_])vl($|[-_])/, // qwen3-vl-*（只做视觉理解）
  /(^|[-_])ocr($|[-_])/, // qwen-vl-ocr
  /search/, // volcsearch-web-search / volcsearch_collab
];

/**
 * 逃生口：这些 selector（逗号分隔）命中黑名单也不过滤，例如
 * `FOB_ALLOW_NON_CHAT_MODELS=futu/qwen3-vl-plus` 让它重新出现在选择器里。
 */
export const NON_CHAT_ALLOWLIST_ENV = 'FOB_ALLOW_NON_CHAT_MODELS';

function nonChatAllowlist(): string[] {
  return (process.env[NON_CHAT_ALLOWLIST_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 该 selector 是否可能是可对话模型 —— `/model` 的选择器与快捷区只放这些。
 * `allow` 是 {@link NON_CHAT_ALLOWLIST_ENV} 解析出的豁免清单（默认现取现用）。
 */
export function isChatModel(
  selector: string,
  allow: readonly string[] = nonChatAllowlist(),
): boolean {
  if (allow.includes(selector)) return true;
  // 只匹配 id 段（`provider/model` 的 model 部分），provider 名不参与，免得误伤。
  const slash = selector.indexOf('/');
  const id = slash < 0 ? selector : selector.slice(slash + 1);
  return !NON_CHAT_ID_PATTERNS.some((re) => re.test(id));
}

/**
 * 丢掉非对话模型并记一条 log（过滤了多少、示例是什么），方便日后核对规则
 * 是不是过宽 / 过窄 —— 规则一旦误伤，用户会看到模型从选择器里消失。
 */
function dropNonChatModels<L extends { selector: string }>(
  list: L[],
  commons: string[],
): { list: L[]; commons: string[] } {
  const allow = nonChatAllowlist();
  const keptList: L[] = [];
  const keptCommons: string[] = [];
  const removed: string[] = [];
  for (const m of list) {
    if (isChatModel(m.selector, allow)) keptList.push(m);
    else removed.push(m.selector);
  }
  for (const sel of commons) {
    if (isChatModel(sel, allow)) keptCommons.push(sel);
    else removed.push(sel);
  }
  if (removed.length > 0) {
    log.info('command', 'non-chat-models-filtered', {
      removed: removed.length,
      kept: keptList.length + keptCommons.length,
      examples: removed.slice(0, 5),
    });
  }
  return { list: keptList, commons: keptCommons };
}

/** Read the configured modelRoles (per-role models in ~/.omp config) and
 * return the distinct chat-model selectors, newest-first as authored. The
 * `default` role often carries a `:thinking` suffix, which is stripped. */
export async function commonOmpModels(cfg: AppConfig): Promise<string[]> {
  const omp = getOmpBinary(cfg);
  try {
    const { stdout } = await execFileAsync(omp, ['config', 'get', 'modelRoles', '--json'], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    const parsed = JSON.parse(stdout) as { value?: Record<string, string> };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const role of Object.keys(parsed.value ?? {})) {
      if (NON_CHAT_ROLES.has(role)) continue;
      const raw = parsed.value?.[role] ?? '';
      const sel = raw.split(':')[0] ?? '';
      if (!sel || !sel.includes('/')) continue;
      if (seen.has(sel)) continue;
      seen.add(sel);
      out.push(sel);
    }
    return out;
  } catch (err) {
    log.warn('command', 'common-models-failed', { err: String(err) });
    return [];
  }
}

export async function listOmpModels(cfg: AppConfig): Promise<OmpModelEntry[]> {
  const omp = getOmpBinary(cfg);
  try {
    const { stdout } = await execFileAsync(omp, ['models', '--json'], {
      encoding: 'utf8',
      env: { ...process.env },
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { models?: OmpModelEntry[] };
    return parsed.models ?? [];
  } catch (err) {
    log.warn('command', 'model-list-failed', { err: String(err) });
    return [];
  }
}

/** Cache entry on disk: both the full model list and the configured common
 * models, refreshed together. */
export interface ModelsCache {
  fetchedAt: number;
  list: OmpModelEntry[];
  commons: string[];
}

const MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function loadModelsCache(): Promise<ModelsCache | undefined> {
  try {
    const text = await readFile(paths.modelsCacheFile, 'utf8');
    const parsed = JSON.parse(text) as ModelsCache;
    if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.list)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function saveModelsCache(cache: ModelsCache): Promise<void> {
  try {
    await mkdir(dirname(paths.modelsCacheFile), { recursive: true });
    const tmp = `${paths.modelsCacheFile}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    await writeFile(tmp, `${JSON.stringify(cache)}\n`, 'utf8');
    await rename(tmp, paths.modelsCacheFile);
  } catch (err) {
    log.warn('command', 'models-cache-write-failed', { err: String(err) });
  }
}

/** Load the model list and common models, using the 7-day disk cache unless
 * `force` requests a refresh (which rewrites the cache).
 *
 * 过滤非对话模型（{@link NON_CHAT_ID_PATTERNS}）放在这里，是最后的出入口：
 * 缓存里存的就是过滤后的列表；老缓存（规则上线前写的）也会在出口处再滤一遍。 */
export async function loadModelData(cfg: AppConfig, force: boolean): Promise<ModelsCache> {
  if (!force) {
    const cached = await loadModelsCache();
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
      return { ...cached, ...dropNonChatModels(cached.list, cached.commons) };
    }
  }
  const [list, commons] = await Promise.all([listOmpModels(cfg), commonOmpModels(cfg)]);
  const fresh: ModelsCache = {
    fetchedAt: Date.now(),
    ...dropNonChatModels(list, commons),
  };
  await saveModelsCache(fresh);
  return fresh;
}

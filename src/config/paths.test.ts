import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { paths } from './paths';

describe('测试环境下的路径隔离', () => {
  it('paths 被重定向到临时目录，绝不可写真实 ~/.feishu-omp-bridge', () => {
    // 事故复盘：曾有测试没覆盖 paths.runningCardsFile，把真机文件写空（且跨 worker 互相干扰）。
    expect(paths.appDir).toContain(tmpdir());
    expect(paths.appDir).not.toContain('.feishu-omp-bridge');
    for (const key of Object.keys(paths) as Array<keyof typeof paths>) {
      expect(String(paths[key])).toContain(tmpdir());
    }
  });
});

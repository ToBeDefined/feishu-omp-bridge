import { describe, expect, it } from 'vitest';
import { buildUnit } from './systemd';

const base = {
  nodePath: '/usr/local/bin/node',
  bridgeEntryPath: '/opt/bridge/bin/feishu-omp-bridge.mjs',
  envPath: '/usr/bin:/bin',
};

describe('buildUnit', () => {
  it('wires node, entry and PATH into ExecStart/Environment', () => {
    const unit = buildUnit(base);
    expect(unit).toContain(`ExecStart="${base.nodePath}" "${base.bridgeEntryPath}" run`);
    expect(unit).toContain(`Environment="PATH=${base.envPath}"`);
    expect(unit).toContain('Restart=always');
  });

  it('doubles literal % so systemd specifier expansion cannot mangle paths', () => {
    const unit = buildUnit({
      nodePath: '/opt/n%de/node',
      bridgeEntryPath: '/opt/br%dge/entry.m%js',
      envPath: '/opt/p%ath:/bin',
    });
    // ExecStart 的每个值都要逃逸
    expect(unit).toContain('ExecStart="/opt/n%%de/node" "/opt/br%%dge/entry.m%%js" run');
    // Environment 同理（PATH 常见 %h/%p/%u 等 specifier）
    expect(unit).toContain('Environment="PATH=/opt/p%%ath:/bin"');
    expect(unit).not.toMatch(/(?<!%)%(?!%)/);
  });

  it('keeps doubling % in log paths too', () => {
    const unit = buildUnit(base);
    // daemonStdoutPath 的输出由 paths 模块决定；只要没有裸 % 即可
    expect(unit).toMatch(/^StandardOutput=append:/m);
    expect(unit).not.toMatch(/(?<!%)%(?!%)/);
  });
});

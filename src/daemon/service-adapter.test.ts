import { describe, expect, it } from 'vitest';
import { disablePlistAutostart, parseLaunchdRunningPid } from './service-adapter';

describe('parseLaunchdRunningPid', () => {
  it('returns the pid of a running service', () => {
    const out = [
      'com.feishu-omp-bridge.daemon => file:///Users/x/Library/LaunchAgents/com.feishu-omp-bridge.daemon.plist',
      '\tpid = 4242',
      '\tstate = running',
    ].join('\n');
    expect(parseLaunchdRunningPid(out)).toBe('4242');
  });

  it('returns undefined when the service is loaded but not running', () => {
    const out = [
      'com.feishu-omp-bridge.daemon => file:///Users/x/Library/LaunchAgents/com.feishu-omp-bridge.daemon.plist',
      '\tstate = not running',
      '\tlast exit code = 0',
    ].join('\n');
    expect(parseLaunchdRunningPid(out)).toBeUndefined();
  });

  it('returns undefined for empty output', () => {
    expect(parseLaunchdRunningPid('')).toBeUndefined();
  });
});

describe('disablePlistAutostart', () => {
  const plist = (runAtLoad: string, keepAlive: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>RunAtLoad</key>
    ${runAtLoad}
    <key>KeepAlive</key>
    ${keepAlive}
</dict>
</plist>
`;

  it('flips RunAtLoad and KeepAlive to false', () => {
    const disabled = disablePlistAutostart(plist('<true/>', '<true/>'));
    expect(disabled).toContain('<key>RunAtLoad</key>\n    <false/>');
    expect(disabled).toContain('<key>KeepAlive</key>\n    <false/>');
    expect(disabled).not.toContain('<true/>');
  });

  it('keeps all other keys intact and is idempotent', () => {
    const already = plist('<false/>', '<false/>');
    expect(disablePlistAutostart(already)).toBe(already);
  });
});

import { describe, expect, it } from 'vitest';
import { toolBodyMd, toolHeaderText } from './tool-render';
import { escapeMd } from './templates';
import type { ToolEntry } from './run-state';

function tool(partial: Partial<ToolEntry>): ToolEntry {
  return { id: 't1', name: 'Bash', input: {}, status: 'done', ...partial };
}

describe('toolBodyMd fence safety', () => {
  it('widens the fence when the output contains backticks', () => {
    const body = toolBodyMd(tool({ output: 'before\n```\n[click](https://evil.example)\n```\nafter' }));
    // A 3-backtick fence would be closed by the payload's own ``` line and the
    // rest would render as live markdown (a link the user can be phished into
    // clicking). The delimiter must be longer than anything inside.
    const fences = body.split('\n').filter((line) => /^`+$/.test(line));
    expect(fences[0]).toBe('````');
    expect(fences[fences.length - 1]).toBe('````');
    // The payload's own fences stay inside: shorter than the delimiter.
    expect(fences.slice(1, -1).every((fence) => fence.length < 4)).toBe(true);
  });

  it('keeps plain output in a minimal fence', () => {
    const body = toolBodyMd(tool({ output: 'ok' }));
    expect(body).toContain('```\nok\n```');
  });

  it('does not escape backslashes into inline code spans', () => {
    // Backslash escapes are inert inside a code span, so escaping a path there
    // renders literal backslashes: `src/a\(b\).ts`.
    const body = toolBodyMd(tool({ name: 'Read', input: { file_path: 'src/a(b)[1].ts' } }));
    expect(body).toContain('`src/a(b)[1].ts`');
    expect(body).not.toContain('\\(');
  });
});

describe('escapeMd', () => {
  it('neutralises link and image syntax from untrusted text', () => {
    expect(escapeMd('[click](https://evil.example)')).not.toContain('[click](');
    expect(escapeMd('![](https://evil.example/pixel)')).not.toContain('![');
  });

  it('still escapes emphasis markers', () => {
    expect(escapeMd('a*b_c`d')).toBe('a\\*b\\_c\\`d');
  });
});

describe('toolHeaderText', () => {
  it('summarises the command without escaping the tool name', () => {
    expect(toolHeaderText(tool({ status: 'running', input: { command: 'git status' } }))).toBe(
      '⏳ **Bash** — git status',
    );
  });
});

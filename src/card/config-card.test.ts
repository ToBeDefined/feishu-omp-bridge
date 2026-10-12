import { describe, expect, it } from 'vitest';
import {
  configCancelledCard,
  configFormCard,
  configInvalidCard,
  configSaveFailedCard,
  configSavedCard,
} from './config-card';

const OPTS = {
  messageReply: 'card' as const,
  showToolCalls: true,
  maxConcurrentRuns: 10,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: true,
  allowedUsers: 'ou_a, ou_b',
  allowedChats: '',
  admins: 'ou_a',
  owner: 'ou_owner',
};

function elements(card: object): unknown[] {
  if (!('body' in card)) return [];
  const { body } = card;
  if (typeof body !== 'object' || body === null || !('elements' in body)) return [];
  return Array.isArray(body.elements) ? body.elements : [];
}

/** 卡片上的 markdown 文本（含表单内部的说明行）。 */
function markdown(card: object): string {
  const out: string[] = [];
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      if ('tag' in node && node.tag === 'markdown' && 'content' in node && typeof node.content === 'string') {
        out.push(node.content);
      }
      if ('elements' in node) {
        const inner = node.elements;
        if (Array.isArray(inner)) walk(inner);
      }
      if ('columns' in node) {
        const cols = node.columns;
        if (Array.isArray(cols)) walk(cols);
      }
    }
  };
  walk(elements(card));
  return out.join('\n');
}

/** 表单控件的 name 列表。 */
function fieldNames(card: object): string[] {
  const names: string[] = [];
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      if ('tag' in node && node.tag === 'input' && 'name' in node && typeof node.name === 'string') {
        names.push(node.name);
      }
      if ('elements' in node) {
        const inner = node.elements;
        if (Array.isArray(inner)) walk(inner);
      }
    }
  };
  walk(elements(card));
  return names;
}

describe('configFormCard', () => {
  it('renders schema 2.0 with the numeric fields pre-filled', () => {
    const card = configFormCard(OPTS) as { schema?: unknown };
    expect(card.schema).toBe('2.0');
    expect(JSON.stringify(configFormCard(OPTS))).toContain('"default_value":"10"');
    expect(JSON.stringify(configFormCard({ ...OPTS, runIdleTimeoutMinutes: 30 }))).toContain(
      '"default_value":"30"',
    );
  });

  it('keeps 归属者 read-only (displayed, never a form field)', () => {
    expect(markdown(configFormCard(OPTS))).toContain('**归属者**(只读):`ou_owner`');
    expect(fieldNames(configFormCard(OPTS))).not.toContain('owner');
  });

  it('uses no legacy action elements (buttons live in column_set rows)', () => {
    expect(JSON.stringify(configFormCard(OPTS))).not.toContain('"tag":"action"');
  });
});

describe('configSavedCard', () => {
  it('summarizes every saved preference', () => {
    const md = markdown(configSavedCard({ ...OPTS, runIdleTimeoutMinutes: 15 }));
    expect(md).toContain('✅ **偏好已保存**');
    expect(md).toContain('**消息回复方式**:交互卡片');
    expect(md).toContain('**并发上限**:`10`');
    expect(md).toContain('**run 探活**:`15 分钟`');
    expect(md).toContain('**用户白名单**:2 项');
    expect(md).toContain('**群白名单**:_(不限制)_');
  });
});

describe('configCancelledCard', () => {
  it('says nothing changed', () => {
    expect(markdown(configCancelledCard())).toContain('已取消');
  });
});

describe('configInvalidCard', () => {
  it('lists every rejected field and never claims it saved', () => {
    const md = markdown(configInvalidCard(['「并发上限」只接受 1-50 的整数，收到「999」']));
    expect(md).toContain('提交被拒绝，未做任何修改');
    expect(md).toContain('「并发上限」只接受 1-50 的整数，收到「999」');
    expect(md).toContain('原来的卡片还能继续改');
    expect(md).not.toContain('偏好已保存');
    expect(md).not.toContain('已取消');
  });

  it('escapes markdown in the error text', () => {
    const md = markdown(configInvalidCard(['收到「*bogus_']));
    expect(md).toContain('收到「\\*bogus\\_');
  });
});

describe('configSaveFailedCard', () => {
  it('states the failure reason instead of pretending it was cancelled', () => {
    const card = JSON.stringify(configSaveFailedCard('EACCES: permission denied'));
    expect(card).toContain('偏好保存失败，未生效');
    expect(card).toContain('EACCES: permission denied');
    expect(card).toContain('配置未改动');
    expect(card).not.toContain('已取消');
    expect(card).not.toContain('偏好已保存');
  });
});

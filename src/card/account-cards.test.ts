import { describe, expect, it } from 'vitest';
import {
  accountCancelledCard,
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
  accountValidatingCard,
  type CurrentInfo,
} from './account-cards';

interface MdEl {
  tag: string;
  content?: string;
  text_size?: string;
}

/** Collect every markdown element's content, at any depth. */
function markdown(card: object): string {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    if ('tag' in value && value.tag === 'markdown' && 'content' in value && typeof value.content === 'string') {
      out.push(value.content);
    }
    Object.values(value).forEach(visit);
  };
  visit(card);
  return out.join('\n');
}

/** Top-level `body.elements`, narrowed at runtime (no unchecked shape trust). */
function elements(card: object): MdEl[] {
  if ('body' in card) {
    const body = card.body;
    if (typeof body === 'object' && body !== null && 'elements' in body) {
      const els = body.elements;
      if (Array.isArray(els)) return els as MdEl[]; // our own hand-built markdown specs
    }
  }
  return [];
}

function summaryOf(card: object): string {
  if ('config' in card) {
    const config = card.config;
    if (typeof config === 'object' && config !== null && 'summary' in config) {
      const summary = config.summary;
      if (typeof summary === 'object' && summary !== null && 'content' in summary) {
        return String(summary.content);
      }
    }
  }
  throw new Error('card has no summary');
}

const CURRENT: CurrentInfo = { appId: 'cli_abcdefghijklmnop', botName: '尼莫', tenant: 'feishu' };

describe('accountCurrentCard', () => {
  it('renders a heading, context, grey info panel and an inline primary action', () => {
    const card = accountCurrentCard(CURRENT);
    const first = elements(card)[0];
    expect(first?.tag).toBe('markdown');
    expect(first?.text_size).toBe('heading');
    expect(first?.content).toBe('📋 **当前应用**');
    expect(markdown(card)).toContain('**📋 应用信息**');
    const json = JSON.stringify(card);
    expect(json).toContain('"tag":"column_set"');
    expect(json).not.toContain('"tag":"hr"');
    expect(json).toContain('"cmd":"account.change"');
    expect(json).toContain('"type":"primary"');
  });
});

describe('accountFormCard', () => {
  it('renders a heading + notation and escapes the inline error message', () => {
    const card = accountFormCard({ errorMessage: 'boom`x' });
    expect(elements(card)[0]?.text_size).toBe('heading');
    expect(elements(card)[0]?.content).toBe('🔑 **更换凭据**');
    const mdText = markdown(card);
    expect(mdText).toContain('❌ **校验失败**');
    expect(mdText).toContain("boom'x");
    expect(mdText).not.toContain('boom`x');
  });

  it('omits the error line when there is no error', () => {
    expect(markdown(accountFormCard())).not.toContain('校验失败');
  });
});

describe('accountValidatingCard', () => {
  it('titles the progress card and uses a real ellipsis in both summary and body', () => {
    const card = accountValidatingCard();
    expect(summaryOf(card)).toBe('正在校验');
    expect(elements(card)[0]?.text_size).toBe('heading');
    const json = JSON.stringify(card);
    expect(json).toContain('…');
    expect(json).not.toContain('...');
  });
});

describe('accountSuccessCard', () => {
  it('renders a heading, context notation and a grey app-info panel', () => {
    const card = accountSuccessCard(CURRENT);
    expect(elements(card)[0]?.text_size).toBe('heading');
    expect(elements(card)[0]?.content).toBe('✅ **凭据已保存**');
    expect(markdown(card)).toContain('**📋 应用信息**');
    expect(markdown(card)).toContain('**Bot 名**: 尼莫');
    expect(JSON.stringify(card)).not.toContain('...');
  });
});

describe('accountFailureCard', () => {
  it('escapes an injected backtick in the reason', () => {
    const mdText = markdown(accountFailureCard('bad `secret`'));
    expect(elements(accountFailureCard('x'))[0]?.text_size).toBe('heading');
    expect(mdText).toContain("bad 'secret'");
    expect(mdText).not.toContain('`secret`');
  });
});

describe('accountCancelledCard', () => {
  it('uses a full-width comma, matching the other cancelled cards', () => {
    expect(markdown(accountCancelledCard())).toContain('已取消，未做任何修改。');
  });
});

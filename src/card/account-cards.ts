import type { TenantBrand } from '../config/schema';
import { escapeCode } from '../utils/text';
import { inlineActions, inlineRow, md, panel, stackedPanels } from './templates';

function maskAppId(id: string): string {
  if (id.length < 12) return id;
  return `${id.slice(0, 13)}****${id.slice(-2)}`;
}

export interface CurrentInfo {
  appId: string;
  botName?: string;
  tenant: TenantBrand;
}

export function accountCurrentCard(info: CurrentInfo): object {
  return {
    schema: '2.0',
    config: { summary: { content: '当前应用' } },
    body: {
      elements: [
        md('📋 **当前应用**', 'heading'),
        md('_当前 bot 使用的应用凭据。_', 'notation'),
        // 事实进灰底块（与 /context /status 同一套观感），动作留在块外。
        ...stackedPanels([
          panel([
            md('**📋 应用信息**'),
            md(`**App ID**: \`${maskAppId(info.appId)}\``),
            md(`**Bot 名**: ${info.botName ?? '(未知)'}`),
            md(`**Tenant**: ${info.tenant}`),
          ]),
        ]),
        ...inlineActions([
          { text: '更换凭据', value: { cmd: 'account.change' }, style: 'primary' },
        ]),
      ],
    },
  };
}

export interface FormCardOpts {
  initialTenant?: TenantBrand;
  prefillAppId?: string;
  errorMessage?: string;
}

export function accountFormCard(opts: FormCardOpts = {}): object {
  const { initialTenant = 'feishu', prefillAppId, errorMessage } = opts;
  const bodyElements: object[] = [
    md('🔑 **更换凭据**', 'heading'),
    md('_粘贴新应用的 App ID / Secret，提交后会立即校验并重连。_', 'notation'),
  ];
  if (errorMessage) {
    bodyElements.push({
      tag: 'markdown',
      content: `❌ **校验失败**：\`${escapeCode(errorMessage)}\``,
    });
  }
  bodyElements.push({
    tag: 'form',
    name: 'account_form',
    elements: [
      {
        tag: 'input',
        name: 'app_id',
        label: { tag: 'plain_text', content: 'App ID' },
        placeholder: { tag: 'plain_text', content: 'cli_xxxxxxxxxxxx' },
        ...(prefillAppId ? { default_value: prefillAppId } : {}),
        required: true,
      },
      {
        tag: 'input',
        name: 'app_secret',
        label: { tag: 'plain_text', content: 'App Secret' },
        placeholder: { tag: 'plain_text', content: '32 位字符串' },
        // Never prefill secret — even on validation retry. Pre-filled secrets
        // can leak into Lark's server-side card cache.
        required: true,
      },
      { tag: 'markdown', content: '**Tenant**' },
      {
        tag: 'select_static',
        name: 'tenant',
        initial_option: initialTenant,
        options: [
          { text: { tag: 'plain_text', content: 'Feishu (国内)' }, value: 'feishu' },
          { text: { tag: 'plain_text', content: 'Lark (海外)' }, value: 'lark' },
        ],
      },
      ...inlineRow([{ element: { tag: 'button', name: 'submit_btn', text: { tag: 'plain_text', content: '提交' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'account.submit' } }], } }]),
      ...inlineRow([{ element: { tag: 'button', name: 'cancel_btn', text: { tag: 'plain_text', content: '取消' }, behaviors: [{ type: 'callback', value: { cmd: 'account.cancel' } }], } }]),
    ],
  });

  return {
    schema: '2.0',
    config: { summary: { content: '更换凭据' } },
    body: { elements: bodyElements },
  };
}

export function accountValidatingCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '正在校验' } },
    body: { elements: [md('⏳ **正在校验凭据…**', 'heading')] },
  };
}

export function accountSuccessCard(info: CurrentInfo): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已保存' } },
    body: {
      elements: [
        md('✅ **凭据已保存**', 'heading'),
        md('_正在用新凭据重连 WebSocket…_', 'notation'),
        ...stackedPanels([
          panel([
            md('**📋 应用信息**'),
            md(`**App ID**: \`${maskAppId(info.appId)}\``),
            ...(info.botName ? [md(`**Bot 名**: ${info.botName}`)] : []),
            md(`**Tenant**: ${info.tenant}`),
          ]),
        ]),
        md('⚠️ _如果新 bot 不在此群，后续消息将由新 bot 接管，老 bot 不会再回复。_', 'notation'),
      ],
    },
  };
}

export function accountFailureCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '校验失败' } },
    body: {
      elements: [
        md('❌ **校验失败**', 'heading'),
        md(`\`${escapeCode(reason)}\``),
        md('_请检查 App ID 和 Secret 是否正确，重发 `/account change` 重试。_', 'notation'),
      ],
    },
  };
}

export function accountCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: { elements: [{ tag: 'markdown', content: '已取消，未做任何修改。' }] },
  };
}

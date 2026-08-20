import type { AgentRun, AgentUiResponse } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  pendingUiRequests: Set<string>;
  onUiSettled?: () => void;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();

  register(chatId: string, run: AgentRun): RunHandle {
    const handle: RunHandle = { run, interrupted: false, pendingUiRequests: new Set() };
    this.handles.set(chatId, handle);
    return handle;
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  has(chatId: string): boolean {
    return this.handles.has(chatId);
  }

  /**
   * Whether any run is active for this chat across scopes: the bare chat
   * id (p2p / plain group) or any topic scope `${chatId}:${threadId}`.
   * The scheduler stores tasks by bare chat id, so its busy-check must
   * cover topic runs too — otherwise a scheduled prompt fires while the
   * user's run in a topic of the same chat is still going, running two
   * agents against the same OMP session.
   */
  hasAnyForChat(chatId: string): boolean {
    if (this.handles.has(chatId)) return true;
    const prefix = `${chatId}:`;
    for (const key of this.handles.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   */
  interrupt(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    h.interrupted = true;
    this.handles.delete(chatId);
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  respondToUi(chatId: string, requestId: string, response: AgentUiResponse): boolean {
    const h = this.handles.get(chatId);
    const ok = h?.run.respondToUi?.(requestId, response) === true;
    if (ok) h?.pendingUiRequests.delete(requestId);
    if (ok) h?.onUiSettled?.();
    return ok;
  }

  submitPrompt(chatId: string, kind: 'steer' | 'follow_up', message: string, imagePaths?: string[]): Promise<boolean> {
    const h = this.handles.get(chatId);
    return h?.run.submitPrompt?.(kind, message, imagePaths) ?? Promise.resolve(false);
  }

  compact(chatId: string, customInstructions?: string): boolean {
    const h = this.handles.get(chatId);
    return h?.run.compact?.(customInstructions) === true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    for (const h of all) h.interrupted = true;
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }
}

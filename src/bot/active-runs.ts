import type { AgentRun, AgentUiResponse } from '../agent/types';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  pendingUiRequests: Set<string>;
  onUiSettled?: () => void;
  /** Per-request timeout timers, keyed by UI request id. */
  uiTimers: Map<string, ReturnType<typeof setTimeout>>;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();

  register(chatId: string, run: AgentRun): RunHandle {
    const handle: RunHandle = {
      run,
      interrupted: false,
      pendingUiRequests: new Set(),
      uiTimers: new Map(),
    };
    this.handles.set(chatId, handle);
    return handle;
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) {
      for (const timer of existing.uiTimers.values()) clearTimeout(timer);
      existing.uiTimers.clear();
      this.handles.delete(chatId);
    }
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
    // A user response wins over the timeout — cancel the pending timer so a
    // late timeout can't fire a second response for the same request.
    const timer = h?.uiTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      h?.uiTimers.delete(requestId);
    }
    const ok = h?.run.respondToUi?.(requestId, response) === true;
    if (ok) h?.pendingUiRequests.delete(requestId);
    if (ok) h?.onUiSettled?.();
    return ok;
  }

  /**
   * Arm a timeout for an in-flight UI request. When `timeoutMs` elapses
   * without a user response, `onTimeout` fires (once). Re-arming the same
   * request id clears the previous timer. Returns false when no active run
   * exists for the chat.
   */
  armUiTimeout(chatId: string, requestId: string, timeoutMs: number, onTimeout: () => void): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    const existing = h.uiTimers.get(requestId);
    if (existing) clearTimeout(existing);
    h.uiTimers.set(requestId, setTimeout(() => {
      h.uiTimers.delete(requestId);
      onTimeout();
    }, timeoutMs));
    return true;
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
    for (const h of all) {
      h.interrupted = true;
      for (const timer of h.uiTimers.values()) clearTimeout(timer);
      h.uiTimers.clear();
    }
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }
}

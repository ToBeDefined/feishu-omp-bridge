import type { AgentRun, AgentUiResponse } from '../agent/types';
import { log } from '../core/logger';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  pendingUiRequests: Set<string>;
  onUiSettled?: () => void;
  /** Per-request timeout timers, keyed by UI request id. */
  uiTimers: Map<string, NodeJS.Timeout>;
  /** Compact requested mid-run; fired once the run unregisters. */
  deferredCompact?: () => void;
}

/**
 * A reserved run slot. `claim()` takes it before the first await so a caller
 * that still has slow work ahead of it (pool slot, media download, quote
 * fetch) is not mistaken for an idle scope by the scheduler's busy check or
 * by the pending queue. `register(scope, run, claim)` consumes it.
 */
export interface RunClaim {
  readonly scope: string;
  readonly token: symbol;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  /** Scopes reserved but not yet carrying a run. */
  private readonly claims = new Map<string, symbol>();

  /**
   * Reserve `scope` without a run. Returns undefined when the scope already
   * has a live run or a pending claim — callers must requeue/skip instead of
   * starting a second agent against the same session jsonl.
   */
  claim(scope: string): RunClaim | undefined {
    if (this.handles.has(scope) || this.claims.has(scope)) return undefined;
    const token = Symbol(scope);
    this.claims.set(scope, token);
    return { scope, token };
  }

  /** Drop a claim that never became a run (error path). No-op once consumed. */
  releaseClaim(claim: RunClaim): void {
    if (this.claims.get(claim.scope) === claim.token) this.claims.delete(claim.scope);
  }

  /**
   * Install a run for `scope`. Returns undefined — never clobbering — when the
   * scope is already occupied: either a live handle exists, or the scope is
   * claimed by someone else (a claim is only consumable by its own token).
   */
  register(scope: string, run: AgentRun, claim?: RunClaim): RunHandle | undefined {
    if (this.handles.has(scope)) {
      log.warn('runs', 'register-busy', { scope });
      return undefined;
    }
    if (claim) {
      if (this.claims.get(scope) !== claim.token) {
        log.warn('runs', 'register-claim-lost', { scope });
        return undefined;
      }
      this.claims.delete(scope);
    } else if (this.claims.has(scope)) {
      log.warn('runs', 'register-claimed', { scope });
      return undefined;
    }
    const handle: RunHandle = {
      run,
      interrupted: false,
      pendingUiRequests: new Set(),
      uiTimers: new Map(),
    };
    this.handles.set(scope, handle);
    return handle;
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) {
      for (const timer of existing.uiTimers.values()) clearTimeout(timer);
      existing.uiTimers.clear();
      this.handles.delete(chatId);
      // Run is over (normal end or mid-stream failure) — the session file
      // is settled, so a compact requested while it ran can fire now. The
      // callback re-resolves its own session id, so a /cd reset between
      // request and fire degrades to a no-op inside the callback.
      existing.deferredCompact?.();
    }
  }

  has(chatId: string): boolean {
    return this.handles.has(chatId) || this.claims.has(chatId);
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
    if (this.has(chatId)) return true;
    const prefix = `${chatId}:`;
    for (const key of this.handles.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    for (const key of this.claims.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Claim the bare chat id unless any scope of that chat is already busy —
   * the bare id or any topic scope. The scheduler stores tasks by bare chat
   * id, so its guard must cover topic runs too; otherwise a scheduled prompt
   * fires while the user's run in a topic of the same chat is still going,
   * running two agents against the same OMP session.
   */
  claimChat(chatId: string): RunClaim | undefined {
    if (this.hasAnyForChat(chatId)) return undefined;
    return this.claim(chatId);
  }

  /**
   * Wait until `scope` is free (no handle, no claim). Used by commands that
   * must replace the current run (e.g. /doctor) — registering over a live
   * handle would orphan its timers and its deferred compact.
   */
  async waitForFree(chatId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!this.has(chatId)) return true;
      if (Date.now() >= deadline) return false;
      // Promise.withResolvers needs Node 22+; this package supports Node >= 20.
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Fires stop() fire-and-forget — the old run's
   * generator exits on its own as the subprocess dies.
   *
   * The handle stays in the map until unregister (after reap). Deleting it
   * here would drop a deferred /compact and let the next message --resume
   * the same jsonl while the child is still dying. /new /cd /ws clear the
   * session first; compactIdle then no-ops via resumeFor.
   */
  interrupt(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    h.interrupted = true;
    void h.run.stop().catch(() => {
      /* stop errors are non-fatal */
    });
    return true;
  }

  respondToUi(chatId: string, requestId: string, response: AgentUiResponse): boolean {
    const h = this.handles.get(chatId);
    // A response is only valid while its request is still outstanding: a
    // timeout that already answered, or a double click, must not write a
    // second extension_ui_response frame for the same id.
    if (!h || !h.pendingUiRequests.has(requestId)) return false;
    // A user response wins over the timeout — cancel the pending timer so a
    // late timeout can't fire a second response for the same request.
    const timer = h.uiTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      h.uiTimers.delete(requestId);
    }
    const ok = h.run.respondToUi?.(requestId, response) === true;
    if (ok) {
      h.pendingUiRequests.delete(requestId);
      h.onUiSettled?.();
    }
    return ok;
  }

  /** Forget an outstanding UI request that can no longer be answered. */
  dropUiRequest(chatId: string, requestId: string): void {
    const h = this.handles.get(chatId);
    if (!h) return;
    const timer = h.uiTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      h.uiTimers.delete(requestId);
    }
    h.pendingUiRequests.delete(requestId);
    h.onUiSettled?.();
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

  /**
   * Queue a compact to fire when the chat's current run finishes. Only the
   * latest request is kept — a second /compact replaces the first. Returns
   * false when no run is active (caller should compact immediately).
   */
  deferCompact(chatId: string, fn: () => void): boolean {
    const h = this.handles.get(chatId);
    if (!h) return false;
    h.deferredCompact = fn;
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    this.claims.clear();
    for (const h of all) {
      h.interrupted = true;
      for (const timer of h.uiTimers.values()) clearTimeout(timer);
      h.uiTimers.clear();
    }
    await Promise.allSettled(all.map((h) => h.run.stop()));
  }
}

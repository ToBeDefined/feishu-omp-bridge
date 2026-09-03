export type AgentUiRequest =
  | { id: string; method: 'select'; title: string; options: string[]; timeout?: number }
  | { id: string; method: 'confirm'; title: string; message: string; timeout?: number }
  | { id: string; method: 'input'; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: 'editor'; title: string; prefill?: string; promptStyle?: boolean };

export type AgentUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true; timedOut?: boolean };

export type AgentUiNoticeType = 'info' | 'warning' | 'error';

export interface AgentUiStatus {
  key: string;
  text?: string;
}

export interface AgentUiWidget {
  key: string;
  lines?: string[];
  placement?: 'aboveEditor' | 'belowEditor';
}

export interface AgentHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
}

export interface AgentHostToolResult {
  result: unknown;
  isError?: boolean;
}

export interface AgentHostTool {
  definition: AgentHostToolDefinition;
  execute(args: Record<string, unknown>): Promise<AgentHostToolResult>;
}

export interface AgentHostUriSchemeDefinition {
  scheme: string;
  description?: string;
  writable?: boolean;
  immutable?: boolean;
}

export interface AgentHostUriResult {
  content?: string;
  contentType?: 'text/markdown' | 'application/json' | 'text/plain';
  notes?: string[];
  immutable?: boolean;
  isError?: boolean;
  error?: string;
}

export interface AgentHostUriScheme {
  definition: AgentHostUriSchemeDefinition;
  handle(req: { operation: 'read' | 'write'; url: string; content?: string }): Promise<AgentHostUriResult>;
}

export type AgentEvent =
  | { type: 'system'; sessionId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_update'; id: string; output: string }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'ui_request'; request: AgentUiRequest }
  | { type: 'ui_cancel'; targetId: string }
  | { type: 'ui_notice'; message: string; level?: AgentUiNoticeType }
  | { type: 'ui_status'; status: AgentUiStatus }
  | { type: 'ui_widget'; widget: AgentUiWidget }
  | { type: 'ui_title'; title: string }
  | { type: 'ui_editor_text'; text: string }
  | { type: 'ui_open_url'; url: string; instructions?: string; launchUrl?: string }
  | { type: 'subagent_lifecycle'; id: string; agent: string; description?: string; status: 'started' | 'completed' | 'failed' | 'aborted' }
  | { type: 'done'; sessionId?: string }
  | { type: 'error'; message: string };

export interface AgentRunOptions {
  prompt: string;
  cwd?: string;
  sessionId?: string;
  /**
   * Override the session directory for this run. Lets one-shot runs (e.g.
   * /rename auto title generation) use an isolated, throwaway session dir
   * instead of polluting the shared session store or the main session.
   * Falls back to the adapter-level sessionDir when unset.
   */
  sessionDir?: string;
  model?: string;
  /** Thinking level override; falls back to the adapter's default when unset. */
  thinking?: string;
  /** Local image paths to pass to agents that support native image flags. */
  imagePaths?: string[];
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
   */
  stopGraceMs?: number;
  hostTools?: AgentHostTool[];
  hostUriSchemes?: AgentHostUriScheme[];
}

export interface AgentRun {
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  respondToUi?(requestId: string, response: AgentUiResponse): boolean;
  submitPrompt?(kind: 'steer' | 'follow_up', message: string, imagePaths?: string[]): Promise<boolean>;
  /** Ask the agent to compact its session context (OMP `compact` command). */
  compact?(customInstructions?: string): boolean;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * The terminal event may arrive before the adapter process has actually
   * closed stdout — there can be a brief telemetry/cleanup tail in between.
   * Calling stop() in that window forces termination and can turn a clean run
   * into a signal exit; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Compact a persisted session by spawning a short-lived agent process:
   * resume the session, send the compact command, wait for the result.
   * Used when no run is active for the chat — the bridge spawns one OMP
   * process per message, so idle sessions have no live process to compact.
   * Returns the human-readable error on failure, undefined on success.
   */
  compactSession?(opts: { sessionId: string; cwd?: string; model?: string; customInstructions?: string }): Promise<string | undefined>;
}

export interface AssistantTurnPreview {
  /** Parallel batch accent slot index from the parent tool call. */
  colorSlot: number;
  /** Context label for the source stream (e.g. `[Researcher]`). */
  contextLabel: string;
}

export interface AgentIO {
  setAgentRunning(running: boolean): void;
  resetAbort(): void;
  startSpinner(): void;
  stopSpinner(): void;
  getAbortSignal(): AbortSignal;
  isAborted(): boolean;

  streamText(text: string): void;
  endStream(): void;
  /**
   * Optional compact preview hook for assistant turn text (used to avoid
   * interleaved token streams from parallel nested subagent runs).
   */
  assistantTurnPreview?(text: string, meta: AssistantTurnPreview): void;
  info(msg: string): void;
  error(msg: string): void;
  handoverBanner(): void;
  userInterjection(text: string): void;

  getPendingInput(): string | null;
  hasPendingInput(): boolean;

  /**
   * @param contextLabel Optional log prefix (e.g. subagent display name in brackets).
   * @param colorSlot When set with parallel execution, TUI uses a distinct accent per slot index.
   */
  toolCall(name: string, args: Record<string, unknown>, contextLabel?: string, colorSlot?: number): void;
  /**
   * @param contextLabel Optional log prefix shown before the tool name (e.g. `[My subagent]`).
   * @param colorSlot When set with parallel execution, TUI uses a distinct accent per slot index.
   */
  toolCallCompact(name: string, args: Record<string, unknown>, contextLabel?: string, colorSlot?: number): void;
  toolResult(summary: string, hasDiff: boolean, colorSlot?: number): void;
  diff(colorizedDiff: string, colorSlot?: number): void;
}

export interface AgentIO {
  setAgentRunning(running: boolean): void;
  resetAbort(): void;
  startSpinner(): void;
  stopSpinner(): void;
  getAbortSignal(): AbortSignal;
  isAborted(): boolean;

  streamText(text: string): void;
  endStream(): void;
  info(msg: string): void;
  error(msg: string): void;
  handoverBanner(): void;
  userInterjection(text: string): void;

  getPendingInput(): string | null;
  hasPendingInput(): boolean;

  /** @param contextLabel Optional log prefix (e.g. subagent display name in brackets). */
  toolCall(name: string, args: Record<string, unknown>, contextLabel?: string): void;
  /** @param contextLabel Optional log prefix shown before the tool name (e.g. `[My subagent]`). */
  toolCallCompact(name: string, args: Record<string, unknown>, contextLabel?: string): void;
  toolResult(summary: string, hasDiff: boolean): void;
  diff(colorizedDiff: string): void;
}

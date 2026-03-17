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

  toolCall(name: string, args: Record<string, unknown>): void;
  toolCallCompact(name: string, args: Record<string, unknown>): void;
  toolResult(summary: string, hasDiff: boolean): void;
  diff(colorizedDiff: string): void;
}

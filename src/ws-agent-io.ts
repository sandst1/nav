import type { AgentIO } from "./agent-io";
import type { UiServerMessage } from "./ui-protocol";

type EmitMessage = (msg: UiServerMessage) => void;

export class WsAgentIO implements AgentIO {
  private inputQueue: string[] = [];
  private abortController: AbortController | null = null;
  private aborted = false;
  private running = false;
  private streamedText = "";

  private emit: EmitMessage;

  constructor(emit: EmitMessage) {
    this.emit = emit;
  }

  setEmitter(emit: EmitMessage): void {
    this.emit = emit;
  }

  enqueueInput(input: string): void {
    this.inputQueue.push(input);
  }

  abortRun(): void {
    this.abortController?.abort();
    this.aborted = true;
    this.emit({ type: "status", payload: { phase: "aborted", message: "Run cancelled." } });
  }

  isRunning(): boolean {
    return this.running;
  }

  setAgentRunning(running: boolean): void {
    this.running = running;
    this.emit({
      type: "status",
      payload: { phase: running ? "running" : "idle" },
    });
  }

  resetAbort(): void {
    this.aborted = false;
    this.abortController = null;
    this.streamedText = "";
  }

  startSpinner(): void {
    // No-op in websocket mode; UI renders its own activity indicator.
  }

  stopSpinner(): void {
    // No-op in websocket mode.
  }

  getAbortSignal(): AbortSignal {
    this.abortController = new AbortController();
    this.aborted = false;
    return this.abortController.signal;
  }

  isAborted(): boolean {
    return this.aborted;
  }

  streamText(text: string): void {
    this.streamedText += text;
    this.emit({ type: "assistant.delta", payload: { text } });
  }

  endStream(): void {
    this.emit({ type: "assistant.done", payload: { text: this.streamedText } });
    this.streamedText = "";
  }

  info(msg: string): void {
    this.emit({ type: "status", payload: { phase: "info", message: msg } });
  }

  error(msg: string): void {
    this.emit({ type: "error", payload: { message: msg } });
  }

  handoverBanner(): void {
    this.emit({
      type: "status",
      payload: { phase: "handover", message: "Continuing in a fresh context." },
    });
  }

  userInterjection(text: string): void {
    this.emit({ type: "status", payload: { phase: "interjection", message: text } });
  }

  getPendingInput(): string | null {
    return this.inputQueue.shift() ?? null;
  }

  hasPendingInput(): boolean {
    return this.inputQueue.length > 0;
  }

  toolCall(name: string, args: Record<string, unknown>): void {
    this.emit({ type: "tool.call", payload: { name, args } });
  }

  toolCallCompact(name: string, args: Record<string, unknown>): void {
    this.emit({ type: "tool.call", payload: { name, args } });
  }

  toolResult(summary: string, hasDiff: boolean): void {
    this.emit({ type: "tool.result", payload: { summary, hasDiff } });
  }

  diff(colorizedDiff: string): void {
    this.emit({
      type: "tool.result",
      payload: { summary: "diff", hasDiff: true, diff: colorizedDiff },
    });
  }
}

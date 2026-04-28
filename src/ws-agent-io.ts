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
  private threadId: string;

  constructor(emit: EmitMessage, threadId: string) {
    this.emit = emit;
    this.threadId = threadId;
  }

  setEmitter(emit: EmitMessage): void {
    this.emit = emit;
  }

  getThreadId(): string {
    return this.threadId;
  }

  enqueueInput(input: string): void {
    this.inputQueue.push(input);
  }

  abortRun(): void {
    this.abortController?.abort();
    this.aborted = true;
    this.emit({ type: "status", payload: { threadId: this.threadId, phase: "aborted", message: "Run cancelled." } });
  }

  isRunning(): boolean {
    return this.running;
  }

  setAgentRunning(running: boolean): void {
    this.running = running;
    this.emit({
      type: "status",
      payload: { threadId: this.threadId, phase: running ? "running" : "idle" },
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
    this.emit({ type: "assistant.delta", payload: { threadId: this.threadId, text } });
  }

  endStream(): void {
    this.emit({ type: "assistant.done", payload: { threadId: this.threadId, text: this.streamedText } });
    this.streamedText = "";
  }

  info(msg: string): void {
    this.emit({ type: "status", payload: { threadId: this.threadId, phase: "info", message: msg } });
  }

  error(msg: string): void {
    this.emit({ type: "error", payload: { threadId: this.threadId, message: msg } });
  }

  handoverBanner(): void {
    this.emit({
      type: "status",
      payload: { threadId: this.threadId, phase: "handover", message: "Continuing in a fresh context." },
    });
  }

  userInterjection(text: string): void {
    this.emit({ type: "status", payload: { threadId: this.threadId, phase: "interjection", message: text } });
  }

  getPendingInput(): string | null {
    return this.inputQueue.shift() ?? null;
  }

  hasPendingInput(): boolean {
    return this.inputQueue.length > 0;
  }

  toolCall(name: string, args: Record<string, unknown>, contextLabel?: string, colorSlot?: number): void {
    this.emit({
      type: "tool.call",
      payload: {
        threadId: this.threadId,
        name,
        args,
        ...(contextLabel ? { contextLabel } : {}),
        ...(colorSlot !== undefined ? { colorSlot } : {}),
      },
    });
  }

  toolCallCompact(name: string, args: Record<string, unknown>, contextLabel?: string, colorSlot?: number): void {
    this.emit({
      type: "tool.call",
      payload: {
        threadId: this.threadId,
        name,
        args,
        ...(contextLabel ? { contextLabel } : {}),
        ...(colorSlot !== undefined ? { colorSlot } : {}),
      },
    });
  }

  toolResult(summary: string, hasDiff: boolean, colorSlot?: number): void {
    this.emit({
      type: "tool.result",
      payload: {
        threadId: this.threadId,
        summary,
        hasDiff,
        ...(colorSlot !== undefined ? { colorSlot } : {}),
      },
    });
  }

  diff(colorizedDiff: string, colorSlot?: number): void {
    this.emit({
      type: "tool.result",
      payload: {
        threadId: this.threadId,
        summary: "diff",
        hasDiff: true,
        diff: colorizedDiff,
        ...(colorSlot !== undefined ? { colorSlot } : {}),
      },
    });
  }
}

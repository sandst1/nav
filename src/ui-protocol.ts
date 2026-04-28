import type { Provider } from "./config";

export const UI_PROTOCOL_VERSION = 2;

export interface ThreadInfo {
  threadId: string;
  createdAt: string;
  messageCount: number;
  isRunning: boolean;
}

export type UiClientMessage =
  | { type: "session.start"; payload?: { protocolVersion?: number } }
  | { type: "thread.create"; payload?: { threadId?: string; systemPromptPrefix?: string } }
  | { type: "thread.list" }
  | { type: "thread.delete"; payload: { threadId: string } }
  | { type: "message.user"; payload: { threadId: string; text: string } }
  | { type: "run.cancel"; payload: { threadId: string } }
  | { type: "session.stop" };

export type UiServerMessage =
  | {
      type: "session.ready";
      payload: {
        protocolVersion: number;
        model: string;
        provider: Provider;
        cwd: string;
        sandbox: boolean;
      };
    }
  | { type: "thread.created"; payload: { threadId: string } }
  | { type: "thread.list"; payload: { threads: ThreadInfo[] } }
  | { type: "thread.deleted"; payload: { threadId: string } }
  | { type: "assistant.delta"; payload: { threadId: string; text: string } }
  | { type: "assistant.done"; payload: { threadId: string; text: string } }
  | {
      type: "tool.call";
      payload: {
        threadId: string;
        name: string;
        args: Record<string, unknown>;
        /** Present when the call originates from a nested subagent (UI may show it). */
        contextLabel?: string;
        /** Index for parallel tool batch accent color (optional). */
        colorSlot?: number;
      };
    }
  | {
      type: "tool.result";
      payload: {
        threadId: string;
        summary: string;
        hasDiff: boolean;
        diff?: string;
        colorSlot?: number;
      };
    }
  | { type: "status"; payload: { threadId?: string; phase: string; message?: string } }
  | { type: "error"; payload: { threadId?: string; message: string } };

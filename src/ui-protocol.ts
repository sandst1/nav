import type { Provider } from "./config";

export const UI_PROTOCOL_VERSION = 1;

export type UiClientMessage =
  | { type: "session.start"; payload?: { protocolVersion?: number } }
  | { type: "message.user"; payload: { text: string } }
  | { type: "run.cancel" }
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
  | { type: "assistant.delta"; payload: { text: string } }
  | { type: "assistant.done"; payload: { text: string } }
  | { type: "tool.call"; payload: { name: string; args: Record<string, unknown> } }
  | { type: "tool.result"; payload: { summary: string; hasDiff: boolean; diff?: string } }
  | { type: "status"; payload: { phase: string; message?: string } }
  | { type: "error"; payload: { message: string } };

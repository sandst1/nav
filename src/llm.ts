/**
 * LLM provider abstraction — unified interface for OpenAI-compatible and Anthropic.
 * Handles streaming, tool calling, and message format translation.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { Ollama } from "ollama";
import type { Config } from "./config";
import { getOpenAITools, getAnthropicTools, getOllamaTools } from "./tools/index";

// --- Unified message types ---

export interface TextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface AssistantToolCallMessage {
  role: "assistant";
  content: string | null;
  tool_calls: ToolCallInfo[];
}

export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type Message =
  | TextMessage
  | AssistantToolCallMessage
  | ToolResultMessage;

export interface StreamEvent {
  type: "text" | "tool_call" | "done";
  /** Incremental text delta */
  text?: string;
  /** Complete tool call (only on type=tool_call) */
  toolCall?: ToolCallInfo;
  /** Usage stats (only on type=done) */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMClient {
  stream(
    systemPrompt: string,
    messages: Message[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent>;
}

// --- OpenAI-compatible client ---

function createOpenAIClient(config: Config): LLMClient {
  const client = new OpenAI({
    apiKey: config.apiKey || "dummy", // Ollama/LM Studio don't need keys
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });

  const tools = getOpenAITools();

  return {
    async *stream(systemPrompt: string, messages: Message[], signal?: AbortSignal) {
      // Convert messages to OpenAI format
      const oaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        ...messages.map(convertToOpenAI),
      ];

      const stream = await client.chat.completions.create({
        model: config.model,
        messages: oaiMessages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal });

      let currentText = "";
      const toolCalls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let usage: { inputTokens: number; outputTokens: number } | undefined;

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];

        if (choice?.delta?.content) {
          currentText += choice.delta.content;
          yield { type: "text", text: choice.delta.content };
        }

        // Tool call deltas
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, {
                id: tc.id ?? `call_${idx}`,
                name: tc.function?.name ?? "",
                arguments: "",
              });
            }
            const existing = toolCalls.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments)
              existing.arguments += tc.function.arguments;
          }
        }

        // Usage info
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }

      // Yield completed tool calls
      for (const [, tc] of toolCalls) {
        yield { type: "tool_call", toolCall: tc };
      }

      yield { type: "done", usage };
    },
  };
}

function convertToOpenAI(msg: Message): OpenAI.Chat.ChatCompletionMessageParam {
  if (msg.role === "tool") {
    return {
      role: "tool",
      tool_call_id: msg.tool_call_id,
      content: msg.content,
    };
  }
  if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
    return {
      role: "assistant",
      content: msg.content ?? undefined,
      tool_calls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      })),
    };
  }
  return {
    role: msg.role as "user" | "assistant",
    content: msg.content as string,
  };
}

// --- Anthropic client ---

function createAnthropicClient(config: Config): LLMClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
  });

  const tools = getAnthropicTools();

  return {
    async *stream(systemPrompt: string, messages: Message[], signal?: AbortSignal) {
      // Convert messages to Anthropic format
      const anthropicMessages = convertToAnthropicMessages(messages);

      const stream = client.messages.stream({
        model: config.model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: tools as any,
      }, { signal });

      const toolCalls: ToolCallInfo[] = [];
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "text", text: event.delta.text };
        }

        if (
          event.type === "content_block_delta" &&
          event.delta.type === "input_json_delta"
        ) {
          // Tool input streaming — we accumulate and emit on block_stop
        }

        if (event.type === "content_block_stop") {
          // Check if this was a tool_use block
        }

        if (event.type === "message_delta") {
          if (event.usage) {
            outputTokens = event.usage.output_tokens ?? 0;
          }
        }
      }

      // Get the final message for complete tool calls
      const finalMessage = await stream.finalMessage();
      inputTokens = finalMessage.usage?.input_tokens ?? 0;
      outputTokens = finalMessage.usage?.output_tokens ?? 0;

      for (const block of finalMessage.content) {
        if (block.type === "tool_use") {
          yield {
            type: "tool_call",
            toolCall: {
              id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          };
        }
      }

      yield {
        type: "done",
        usage: { inputTokens, outputTokens },
      };
    },
  };
}

function convertToAnthropicMessages(
  messages: Message[],
): Anthropic.Messages.MessageParam[] {
  const result: Anthropic.Messages.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content as string });
    } else if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
      const content: Anthropic.Messages.ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments),
        });
      }
      result.push({ role: "assistant", content });
    } else if (msg.role === "assistant") {
      result.push({ role: "assistant", content: msg.content as string });
    } else if (msg.role === "tool") {
      // Anthropic expects tool results in a user message with tool_result blocks
      // Check if previous message is already a user message with tool results
      const prev = result[result.length - 1];
      const toolResult: Anthropic.Messages.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: msg.content,
      };
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as Anthropic.Messages.ContentBlockParam[]).push(toolResult);
      } else {
        result.push({ role: "user", content: [toolResult] });
      }
    }
  }

  return result;
}

// --- Ollama native client ---

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

function createOllamaClient(config: Config): LLMClient {
  const client = new Ollama({ host: config.baseUrl || "http://127.0.0.1:11434" });
  const tools = getOllamaTools();

  return {
    async *stream(systemPrompt: string, messages: Message[], signal?: AbortSignal) {
      // Convert nav messages to Ollama format
      const ollamaMessages: OllamaMessage[] = [
        { role: "system", content: systemPrompt },
        ...convertToOllamaMessages(messages),
      ];

      const response = await client.chat({
        model: config.model,
        messages: ollamaMessages as any,
        tools: tools.length > 0 ? (tools as any) : undefined,
        stream: true,
      });

      // Abort on signal
      if (signal) {
        signal.addEventListener("abort", () => (response as any).abort?.(), { once: true });
      }

      let assistantText = "";
      const toolCalls: ToolCallInfo[] = [];
      let promptEvalCount = 0;
      let evalCount = 0;

      try {
        for await (const chunk of response) {
          if (signal?.aborted) break;

          // Text content
          if (chunk.message?.content) {
            assistantText += chunk.message.content;
            yield { type: "text", text: chunk.message.content };
          }

          // Tool calls come in the final chunk (when chunk.done === true)
          if (chunk.message?.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              toolCalls.push({
                id: `call_${toolCalls.length}`,
                name: tc.function.name,
                arguments: JSON.stringify(tc.function.arguments),
              });
            }
          }

          // Usage stats from final chunk
          if (chunk.done) {
            promptEvalCount = (chunk as any).prompt_eval_count ?? 0;
            evalCount = (chunk as any).eval_count ?? 0;
          }
        }
      } catch (e: unknown) {
        if (signal?.aborted) {
          // Abort is not an error — just stop
        } else {
          throw e;
        }
      }

      // Yield completed tool calls
      for (const tc of toolCalls) {
        yield { type: "tool_call", toolCall: tc };
      }

      yield {
        type: "done",
        usage: { inputTokens: promptEvalCount, outputTokens: evalCount },
      };
    },
  };
}

function convertToOllamaMessages(messages: Message[]): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content as string });
    } else if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
      const ollamaMsg: OllamaMessage = {
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: JSON.parse(tc.arguments),
          },
        })),
      };
      result.push(ollamaMsg);
    } else if (msg.role === "assistant") {
      result.push({ role: "assistant", content: msg.content as string });
    } else if (msg.role === "tool") {
      // Ollama tool results: look up the tool name from the preceding assistant message's tool_calls
      let toolName = "unknown";
      // Walk back to find the assistant message with matching tool_call_id
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j]!;
        if (prev.role === "assistant" && "tool_calls" in prev && prev.tool_calls) {
          const match = prev.tool_calls.find((tc) => tc.id === msg.tool_call_id);
          if (match) {
            toolName = match.name;
            break;
          }
        }
      }
      result.push({ role: "tool", content: msg.content } as any);
    }
  }

  return result;
}

// --- Factory ---

export function createLLMClient(config: Config): LLMClient {
  if (config.provider === "anthropic") {
    return createAnthropicClient(config);
  }
  if (config.provider === "ollama") {
    return createOllamaClient(config);
  }
  return createOpenAIClient(config);
}

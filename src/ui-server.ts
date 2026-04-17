import { SkillWatcher } from "./skill-watcher";
import type { Config } from "./config";
import type { Logger } from "./logger";
import { UI_PROTOCOL_VERSION, type UiClientMessage, type UiServerMessage } from "./ui-protocol";
import { ThreadManager } from "./thread-manager";

interface UiServerOptions {
  config: Config;
  logger: Logger;
  host: string;
  port: number;
}

export async function runUiServer(opts: UiServerOptions): Promise<void> {
  const { config, logger, host, port } = opts;

  const skillWatcher = new SkillWatcher();
  skillWatcher.start(config.cwd);

  const clients = new Set<Bun.ServerWebSocket<unknown>>();

  const broadcast = (msg: UiServerMessage) => {
    const json = JSON.stringify(msg);
    for (const ws of clients) {
      ws.send(json);
    }
  };

  const threadManager = new ThreadManager({
    config,
    logger,
    emit: broadcast,
  });

  const cleanup = () => {
    threadManager.cleanup();
    skillWatcher.stop();
  };

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(req, serverRef) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            ok: true,
            protocolVersion: UI_PROTOCOL_VERSION,
            cwd: config.cwd,
            threadCount: threadManager.list().length,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      if (url.pathname === "/ws" && serverRef.upgrade(req)) {
        return;
      }

      return new Response("nav ui-server v2", { status: 200 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(
          JSON.stringify({
            type: "session.ready",
            payload: {
              protocolVersion: UI_PROTOCOL_VERSION,
              model: config.model,
              provider: config.provider,
              cwd: config.cwd,
              sandbox: config.sandbox,
            },
          } satisfies UiServerMessage),
        );
      },
      message(ws, raw) {
        let msg: UiClientMessage;
        try {
          const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
          msg = JSON.parse(text) as UiClientMessage;
        } catch {
          ws.send(JSON.stringify({ type: "error", payload: { message: "Invalid JSON message." } }));
          return;
        }

        switch (msg.type) {
          case "session.start":
            ws.send(
              JSON.stringify({
                type: "session.ready",
                payload: {
                  protocolVersion: UI_PROTOCOL_VERSION,
                  model: config.model,
                  provider: config.provider,
                  cwd: config.cwd,
                  sandbox: config.sandbox,
                },
              } satisfies UiServerMessage),
            );
            break;

          case "thread.create": {
            const threadId = threadManager.create(msg.payload?.threadId);
            broadcast({ type: "thread.created", payload: { threadId } });
            break;
          }

          case "thread.list": {
            const threads = threadManager.list();
            ws.send(JSON.stringify({ type: "thread.list", payload: { threads } } satisfies UiServerMessage));
            break;
          }

          case "thread.delete": {
            const { threadId } = msg.payload;
            const deleted = threadManager.delete(threadId);
            if (deleted) {
              broadcast({ type: "thread.deleted", payload: { threadId } });
            } else {
              ws.send(
                JSON.stringify({
                  type: "error",
                  payload: { threadId, message: `Thread ${threadId} not found.` },
                } satisfies UiServerMessage),
              );
            }
            break;
          }

          case "message.user": {
            const { threadId, text } = msg.payload;
            if (!text?.trim()) return;

            const thread = threadManager.get(threadId);
            if (!thread) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  payload: { threadId, message: `Thread ${threadId} not found.` },
                } satisfies UiServerMessage),
              );
              return;
            }

            if (thread.pendingUserInputResolve) {
              const resolve = thread.pendingUserInputResolve;
              thread.pendingUserInputResolve = null;
              resolve(text.trim());
              return;
            }

            if (thread.io.isRunning()) {
              thread.io.enqueueInput(text.trim());
              broadcast({
                type: "status",
                payload: { threadId, phase: "queued", message: "Message queued while run is active." },
              });
              return;
            }

            threadManager.enqueue(threadId, () => threadManager.runInput(threadId, text.trim()));
            break;
          }

          case "run.cancel": {
            const { threadId } = msg.payload;
            const thread = threadManager.get(threadId);
            if (thread) {
              thread.io.abortRun();
            } else {
              ws.send(
                JSON.stringify({
                  type: "error",
                  payload: { threadId, message: `Thread ${threadId} not found.` },
                } satisfies UiServerMessage),
              );
            }
            break;
          }

          case "session.stop":
            ws.close(1000, "client closed session");
            break;
        }
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  console.log(`ui-server listening on http://${server.hostname}:${server.port} (ws: /ws) [protocol v${UI_PROTOCOL_VERSION}]`);

  const stop = () => {
    cleanup();
    server.stop(true);
  };

  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(143);
  });
}

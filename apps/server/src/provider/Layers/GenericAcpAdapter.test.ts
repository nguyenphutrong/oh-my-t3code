// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { makeGenericAcpAdapter } from "./GenericAcpAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const provider = ProviderDriverKind.make("acpRegistry");
const instanceId = ProviderInstanceId.make("acpRegistry_mock");
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-generic-acp-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeAdapter = Effect.fn("makeGenericAcpTestAdapter")(function* (
  environment: Record<string, string> = {},
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeGenericAcpAdapter({
    provider,
    instanceId,
    makeRuntime: (input) =>
      AcpSessionRuntime.make({
        spawn: { command: "node", args: [mockAgentPath], env: environment },
        cwd: input.cwd,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        ...(input.resumeMethod ? { resumeMethod: input.resumeMethod } : {}),
        clientInfo: { name: "t3-test", version: "0.0.0" },
        authenticateOnAuthRequired: true,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  });
});

it.effect("runs a generic ACP session, streams tool events, and resolves permission", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter({ T3_ACP_EMIT_TOOL_CALLS: "1" });
    const threadId = ThreadId.make("generic-acp-tool-flow");
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "request.opened" && event.requestId) {
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            );
          }
        }),
      ),
      Effect.forkChild,
    );

    const session = yield* adapter.startSession({
      threadId,
      provider,
      providerInstanceId: instanceId,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "mock-session-1" });

    yield* adapter.sendTurn({ threadId, input: "run the mock tool", attachments: [] });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "session.started",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "request.opened",
        "request.resolved",
        "item.completed",
        "turn.completed",
      ]),
    );
    expect(events.find((event) => event.type === "request.resolved")).toMatchObject({
      payload: { decision: "accept" },
    });
    expect(yield* adapter.hasSession(threadId)).toBe(true);
    yield* adapter.stopSession(threadId);
    expect(yield* adapter.hasSession(threadId)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("clears active turn state after a prompt failure", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter({ T3_ACP_FAIL_PROMPT: "1" });
    const threadId = ThreadId.make("generic-acp-failed-prompt");
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkChild,
    );
    yield* adapter.startSession({
      threadId,
      provider,
      providerInstanceId: instanceId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    const failure = yield* Effect.flip(
      adapter.sendTurn({ threadId, input: "fail", attachments: [] }),
    );
    expect(failure._tag).toBe("ProviderAdapterRequestError");
    expect(yield* adapter.listSessions()).toMatchObject([
      { status: "error", activeTurnId: undefined, lastError: "ACP prompt failed." },
    ]);
    expect(events.findLast((event) => event.type === "turn.completed")).toMatchObject({
      payload: { state: "failed", errorMessage: "ACP prompt failed." },
    });
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

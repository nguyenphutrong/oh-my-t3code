// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ExecuteOptions, StreamMessage } from "@ampcode/sdk";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { makeAmpAdapter } from "./AmpAdapter.ts";

const provider = ProviderDriverKind.make("amp");
const instanceId = ProviderInstanceId.make("amp_test");

function successfulMessages(sessionId = "T-amp-native-1"): ReadonlyArray<StreamMessage> {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: process.cwd(),
      tools: ["Bash", "edit_file"],
      mcp_servers: [],
    },
    {
      type: "assistant",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: "assistant-1",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [
          { type: "text", text: "I will inspect the workspace." },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
      },
    },
    {
      type: "user",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: process.cwd(), is_error: false },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      duration_ms: 5,
      num_turns: 1,
      result: "done",
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    },
  ];
}

function executeFrom(messages: ReadonlyArray<StreamMessage>, calls: ExecuteOptions[]) {
  return (options: ExecuteOptions): AsyncIterable<StreamMessage> => {
    calls.push(options);
    return {
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
    };
  };
}

it.effect("runs a native Amp turn and maps text, tools, usage, and the resume cursor", () =>
  Effect.gen(function* () {
    const calls: ExecuteOptions[] = [];
    const adapter = yield* makeAmpAdapter(
      { binaryPath: "amp" },
      { instanceId, execute: executeFrom(successfulMessages(), calls) },
    );
    const threadId = ThreadId.make("amp-native-success");
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
      modelSelection: {
        instanceId,
        model: "high",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    });
    const result = yield* adapter.sendTurn({
      threadId,
      input: "Inspect this repo",
      attachments: [],
    });

    expect(result.resumeCursor).toEqual({ schemaVersion: 1, threadId: "T-amp-native-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      cwd: process.cwd(),
      mode: "high",
      effort: "xhigh",
      visibility: "private",
      noArchiveAfterExecute: true,
      dangerouslyAllowAll: true,
    });
    expect(calls[0]?.options?.continue).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "session.started",
        "thread.started",
        "turn.started",
        "content.delta",
        "item.started",
        "item.completed",
        "turn.completed",
      ]),
    );
    expect(
      events.find((event) => event.itemId === "tool-1" && event.type === "item.started"),
    ).toMatchObject({ payload: { itemType: "command_execution", title: "Bash" } });
    expect(
      events.find((event) => event.itemId === "tool-1" && event.type === "item.completed"),
    ).toMatchObject({ payload: { itemType: "command_execution", status: "completed" } });
    expect(events.findLast((event) => event.type === "turn.completed")).toMatchObject({
      payload: {
        state: "completed",
        tokenUsage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 },
      },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("continues only the Amp thread encoded in the resume cursor", () =>
  Effect.gen(function* () {
    const calls: ExecuteOptions[] = [];
    const adapter = yield* makeAmpAdapter(
      { binaryPath: "amp" },
      { instanceId, execute: executeFrom(successfulMessages("T-existing"), calls) },
    );
    const threadId = ThreadId.make("amp-native-resume");
    yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      resumeCursor: { schemaVersion: 1, threadId: "T-existing" },
    });
    yield* adapter.sendTurn({ threadId, input: "Continue", attachments: [] });

    expect(calls[0]?.options?.continue).toBe("T-existing");
    expect(calls[0]?.options?.continue).not.toBe(true);
    expect(calls[0]?.options?.dangerouslyAllowAll).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects attachments before launching Amp", () =>
  Effect.gen(function* () {
    const calls: ExecuteOptions[] = [];
    const adapter = yield* makeAmpAdapter(
      { binaryPath: "amp" },
      { instanceId, execute: executeFrom(successfulMessages(), calls) },
    );
    const threadId = ThreadId.make("amp-native-attachment");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const error = yield* Effect.flip(
      adapter.sendTurn({
        threadId,
        input: "Describe this",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "test.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ],
      }),
    );
    expect(error).toMatchObject({
      _tag: "ProviderAdapterValidationError",
      issue: "The official Amp SDK does not support attachments yet.",
    });
    expect(calls).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("aborts the active SDK execution without closing the provider session", () =>
  Effect.gen(function* () {
    const initialized = yield* Deferred.make<void>();
    const threadId = ThreadId.make("amp-native-cancel");
    const events: ProviderRuntimeEvent[] = [];
    const execute = (options: ExecuteOptions): AsyncIterable<StreamMessage> => ({
      async *[Symbol.asyncIterator]() {
        yield successfulMessages()[0]!;
        await Effect.runPromise(Deferred.succeed(initialized, undefined));
        await new Promise<never>((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    });
    const adapter = yield* makeAmpAdapter({ binaryPath: "amp" }, { instanceId, execute });
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkChild,
    );
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const turnFiber = yield* adapter
      .sendTurn({ threadId, input: "Wait", attachments: [] })
      .pipe(Effect.forkChild);
    yield* Deferred.await(initialized);
    yield* adapter.interruptTurn(threadId);
    yield* Fiber.await(turnFiber);

    expect(yield* adapter.listSessions()).toMatchObject([
      { status: "ready", activeTurnId: undefined },
    ]);
    expect(events.findLast((event) => event.type === "turn.completed")).toMatchObject({
      payload: { state: "cancelled", stopReason: "cancelled" },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails one turn when Amp emits an oversized message", () =>
  Effect.gen(function* () {
    const messages = successfulMessages()
      .slice(0, 1)
      .concat({
        type: "assistant",
        session_id: "T-amp-native-1",
        parent_tool_use_id: null,
        message: {
          id: "oversized",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
          stop_reason: "end_turn",
          stop_sequence: null,
        },
      } satisfies StreamMessage);
    const adapter = yield* makeAmpAdapter(
      { binaryPath: "amp" },
      { instanceId, execute: executeFrom(messages, []) },
    );
    const threadId = ThreadId.make("amp-native-oversized");
    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
    const error = yield* Effect.flip(
      adapter.sendTurn({ threadId, input: "Oversize", attachments: [] }),
    );

    expect(error).toMatchObject({
      _tag: "ProviderAdapterRequestError",
      detail: "Amp returned a message larger than 1 MiB.",
    });
    expect(yield* adapter.listSessions()).toMatchObject([
      { status: "error", activeTurnId: undefined },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

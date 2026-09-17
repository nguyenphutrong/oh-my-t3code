// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeAmpAdapter } from "./AmpAdapter.ts";
import type { AmpCliExecute, AmpCliExportThread } from "./AmpCliRuntime.ts";

const instanceId = ProviderInstanceId.make("amp_test");

it.effect("syncs visible Amp history when resuming a thread", () =>
  Effect.gen(function* () {
    const exportThread: AmpCliExportThread = () =>
      Effect.succeed([
        {
          messageId: "protocol-user-1",
          role: "user",
          text: "Original prompt",
          createdAt: "2026-09-17T10:00:00.000Z",
        },
        {
          messageId: "protocol-assistant-1",
          role: "assistant",
          text: "Recovered response",
          createdAt: "2026-09-17T10:00:01.000Z",
        },
      ]);
    const execute: AmpCliExecute = () => Stream.empty;
    const adapter = yield* makeAmpAdapter(
      { binaryPath: "amp" },
      { instanceId, attachmentsDir: process.cwd(), execute, exportThread },
    );
    const events: ProviderRuntimeEvent[] = [];
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkChild,
    );

    yield* adapter.startSession({
      threadId: ThreadId.make("t3-thread"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
      resumeCursor: { schemaVersion: 1, threadId: "T-amp-thread" },
    });

    expect(events.find((event) => event.type === "thread.history.synced")).toMatchObject({
      payload: {
        messages: [
          {
            messageId: "import:amp:T-amp-thread:protocol-user-1",
            role: "user",
            text: "Original prompt",
          },
          {
            messageId: "import:amp:T-amp-thread:protocol-assistant-1",
            role: "assistant",
            text: "Recovered response",
          },
        ],
      },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import type { ExecuteOptions, StreamMessage } from "@ampcode/sdk";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeAmpTextGeneration } from "./AmpTextGeneration.ts";

const instanceId = ProviderInstanceId.make("amp_text_test");

function resultMessages(result: string): ReadonlyArray<StreamMessage> {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: "T-amp-text",
      cwd: process.cwd(),
      tools: [],
      mcp_servers: [],
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "T-amp-text",
      duration_ms: 2,
      num_turns: 1,
      result,
    },
  ];
}

it.effect("generates structured app text through a private tool-denied Amp execution", () =>
  Effect.gen(function* () {
    const calls: ExecuteOptions[] = [];
    const execute = (options: ExecuteOptions): AsyncIterable<StreamMessage> => {
      calls.push(options);
      return {
        async *[Symbol.asyncIterator]() {
          yield* resultMessages('{"branch":"Feature/Amp SDK"}');
        },
      };
    };
    const service = yield* makeAmpTextGeneration(
      { enabled: true, binaryPath: "amp", settingsFile: "" },
      { AMP_API_KEY: "test-key" },
      execute,
    );
    const generated = yield* service.generateBranchName({
      cwd: process.cwd(),
      message: "Add Amp SDK",
      modelSelection: {
        instanceId,
        model: "high",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    });

    expect(generated).toEqual({ branch: "feature/amp-sdk" });
    expect(calls[0]?.options).toMatchObject({
      cwd: process.cwd(),
      mode: "high",
      effort: "xhigh",
      visibility: "private",
      noArchiveAfterExecute: true,
      env: { AMP_API_KEY: "test-key" },
      permissions: [{ tool: "*", action: "reject" }],
    });
    expect(calls[0]?.options?.continue).toBeUndefined();
  }),
);

it.effect("rejects malformed Amp structured output", () =>
  Effect.gen(function* () {
    const execute = (): AsyncIterable<StreamMessage> => ({
      async *[Symbol.asyncIterator]() {
        yield* resultMessages("not json");
      },
    });
    const service = yield* makeAmpTextGeneration(
      { enabled: true, binaryPath: "amp", settingsFile: "" },
      {},
      execute,
    );
    const error = yield* Effect.flip(
      service.generateThreadTitle({
        cwd: process.cwd(),
        message: "A title",
        modelSelection: { instanceId, model: "medium", options: [] },
      }),
    );

    expect(error).toMatchObject({
      _tag: "TextGenerationError",
      operation: "generateThreadTitle",
      detail: "Amp returned invalid structured output.",
    });
  }),
);

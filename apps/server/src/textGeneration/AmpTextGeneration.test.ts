import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type {
  AmpCliExecute,
  AmpCliExecuteInput,
  AmpCliMessage,
} from "../provider/Layers/AmpCliRuntime.ts";
import { makeAmpTextGeneration } from "./AmpTextGeneration.ts";

const instanceId = ProviderInstanceId.make("amp_text_test");

function resultMessages(result: string): ReadonlyArray<AmpCliMessage> {
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
    const calls: AmpCliExecuteInput[] = [];
    const execute: AmpCliExecute = (input) => {
      calls.push(input);
      return Stream.fromIterable(resultMessages('{"branch":"Feature/Amp CLI"}'));
    };
    const service = yield* makeAmpTextGeneration(
      { enabled: true, binaryPath: "amp", settingsFile: "" },
      { AMP_API_KEY: "test-key" },
      execute,
    );
    const generated = yield* service.generateBranchName({
      cwd: process.cwd(),
      message: "Add Amp CLI",
      modelSelection: {
        instanceId,
        model: "high",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    });

    expect(generated).toEqual({ branch: "feature/amp-cli" });
    expect(calls[0]).toMatchObject({
      cwd: process.cwd(),
      mode: "high",
      effort: "xhigh",
      environment: { AMP_API_KEY: "test-key" },
      denyTools: true,
    });
    expect(calls[0]?.continueThreadId).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects malformed Amp structured output", () =>
  Effect.gen(function* () {
    const execute: AmpCliExecute = () => Stream.fromIterable(resultMessages("not json"));
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
  }).pipe(Effect.provide(NodeServices.layer)),
);

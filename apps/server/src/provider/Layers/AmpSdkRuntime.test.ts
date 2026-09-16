// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import type { StreamMessage } from "@ampcode/sdk";

import { startAmpExecution, type AmpSdkExecute } from "./AmpSdkRuntime.ts";

const message: StreamMessage = {
  type: "system",
  subtype: "init",
  session_id: "T-sdk-runtime",
  cwd: "/tmp",
  tools: [],
  mcp_servers: [],
};

it("scopes a custom Amp binary path to the serialized SDK launch window", async () => {
  const original = process.env.AMP_CLI_PATH;
  process.env.AMP_CLI_PATH = "/existing/amp";
  const observed: string[] = [];
  const execute: AmpSdkExecute = () => ({
    async *[Symbol.asyncIterator]() {
      observed.push(process.env.AMP_CLI_PATH ?? "");
      yield message;
    },
  });

  try {
    const first = await startAmpExecution({
      execute,
      binaryPath: "/custom/amp",
      options: { prompt: "test" },
    });
    expect(first.first.value).toEqual(message);
    expect(observed).toEqual(["/custom/amp"]);
    expect(process.env.AMP_CLI_PATH).toBe("/existing/amp");
  } finally {
    if (original === undefined) delete process.env.AMP_CLI_PATH;
    else process.env.AMP_CLI_PATH = original;
  }
});

it("does not override SDK discovery for the default amp command", async () => {
  const original = process.env.AMP_CLI_PATH;
  delete process.env.AMP_CLI_PATH;
  let observed: string | undefined;
  const execute: AmpSdkExecute = () => ({
    async *[Symbol.asyncIterator]() {
      observed = process.env.AMP_CLI_PATH;
      yield message;
    },
  });

  try {
    await startAmpExecution({ execute, binaryPath: "amp", options: { prompt: "test" } });
    expect(observed).toBeUndefined();
    expect(process.env.AMP_CLI_PATH).toBeUndefined();
  } finally {
    if (original === undefined) delete process.env.AMP_CLI_PATH;
    else process.env.AMP_CLI_PATH = original;
  }
});

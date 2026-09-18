// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeAmpCliExecute } from "./AmpCliRuntime.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();

function initMessage(sessionId = "T-cli-runtime") {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: "/workspace",
    tools: [],
    mcp_servers: [],
  } as const;
}

function resultMessage(sessionId = "T-cli-runtime") {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    duration_ms: 1,
    num_turns: 1,
    result: "done",
  } as const;
}

function makeHandle(input: {
  readonly stdout: string;
  readonly stdoutStream?: Stream.Stream<Uint8Array>;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly exitCodeEffect?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly onStdin?: (text: string) => void;
  readonly onKill?: () => void;
}) {
  const decoder = new TextDecoder();
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode:
      input.exitCodeEffect ?? Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.sync(() => input.onKill?.()),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => input.onStdin?.(decoder.decode(chunk, { stream: true }))),
    ),
    stdout:
      input.stdoutStream ??
      (input.stdout ? Stream.make(encoder.encode(input.stdout)) : Stream.empty),
    stderr: input.stderr ? Stream.make(encoder.encode(input.stderr)) : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function executeInput(overrides: Record<string, unknown> = {}) {
  return {
    binaryPath: "/custom/amp",
    cwd: "/workspace",
    environment: { PATH: "/bin" },
    message: {
      type: "user" as const,
      requestId: "turn-1",
      message: {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Inspect this" }],
      },
    },
    mode: "high",
    effort: "xhigh",
    ...overrides,
  };
}

it.effect("spawns Amp with explicit continuation args and streams typed JSONL", () =>
  Effect.gen(function* () {
    let spawned: ChildProcess.StandardCommand | undefined;
    let stdin = "";
    const stdout = [
      initMessage("T-existing"),
      {
        type: "assistant",
        session_id: "T-existing",
        parent_tool_use_id: null,
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "thinking", thinking: "checking" }],
          stop_reason: null,
        },
      },
      resultMessage("T-existing"),
    ]
      .map((message) => encodeJson(message))
      .join("\n");
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        expect(ChildProcess.isStandardCommand(command)).toBe(true);
        if (ChildProcess.isStandardCommand(command)) spawned = command;
        return makeHandle({
          stdout: `${stdout}\n`,
          onStdin: (chunk) => {
            stdin += chunk;
          },
        });
      }),
    );
    const execute = yield* makeAmpCliExecute().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const messages = yield* execute(
      executeInput({
        continueThreadId: "T-existing",
        dangerouslyAllowAll: true,
      }),
    ).pipe(Stream.runCollect);

    expect(spawned?.command).toBe("/custom/amp");
    expect(spawned?.args).toEqual([
      "threads",
      "continue",
      "T-existing",
      "--execute",
      "--stream-json-thinking",
      "--stream-json-input",
      "--plugin-ready-timeout",
      "10",
      "--dangerously-allow-all",
      "--no-archive-after-execute",
      "--visibility",
      "private",
      "--mode",
      "high",
      "--effort",
      "xhigh",
    ]);
    expect([...messages].map((message) => message.type)).toEqual(["system", "assistant", "result"]);
    const decodedInput = yield* decodeUnknownJson(stdin.trim());
    expect(decodedInput).toEqual({
      type: "user",
      request_id: "turn-1",
      message: {
        role: "user",
        content: [{ type: "text", text: "Inspect this" }],
      },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects malformed and oversized Amp stream messages", () =>
  Effect.gen(function* () {
    const outputs = ["not-json\n", `${"x".repeat(1024 * 1024 + 1)}\n`];
    for (const stdout of outputs) {
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeHandle({ stdout })));
      const execute = yield* makeAmpCliExecute().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const error = yield* execute(executeInput()).pipe(Stream.runDrain, Effect.flip);
      expect(error).toMatchObject({ _tag: "AmpCliRuntimeError" });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("merges deny-all permissions into a scoped settings file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sourceDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-amp-source-" });
    const sourceSettings = `${sourceDirectory}/settings.json`;
    yield* fs.writeFileString(sourceSettings, encodeJson({ "amp.someSetting": true }));
    let generatedSettingsPath = "";
    let generatedSettings: unknown;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("standard command");
        const index = command.args.indexOf("--settings-file");
        generatedSettingsPath = command.args[index + 1] ?? "";
        generatedSettings = yield* fs
          .readFileString(generatedSettingsPath)
          .pipe(Effect.flatMap(decodeUnknownJson), Effect.orDie);
        return makeHandle({
          stdout: `${encodeJson(initMessage())}\n${encodeJson(resultMessage())}\n`,
        });
      }),
    );
    const execute = yield* makeAmpCliExecute().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    yield* execute(executeInput({ settingsFile: sourceSettings, denyTools: true })).pipe(
      Stream.runDrain,
    );

    expect(generatedSettings).toEqual({
      "amp.someSetting": true,
      "amp.permissions": [{ tool: "*", action: "reject" }],
      "amp.dangerouslyAllowAll": false,
    });
    expect(yield* fs.exists(generatedSettingsPath)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports authentication failures without exposing stderr", () =>
  Effect.gen(function* () {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeHandle({
          stdout: "",
          stderr: "login required for secret-account@example.test",
          exitCode: 1,
        }),
      ),
    );
    const execute = yield* makeAmpCliExecute().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const error = yield* execute(executeInput()).pipe(Stream.runDrain, Effect.flip);

    expect(error.detail).toBe("Amp authentication is required. Run `amp login` and try again.");
    expect(error.detail).not.toContain("secret-account");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("cancels a running Amp process and releases it", () =>
  Effect.gen(function* () {
    let kills = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeHandle({
          stdout: "",
          stdoutStream: Stream.never,
          exitCodeEffect: Effect.never,
          onKill: () => {
            kills += 1;
          },
        }),
      ),
    );
    const execute = yield* makeAmpCliExecute().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const controller = new AbortController();
    controller.abort();

    const error = yield* execute(executeInput({ signal: controller.signal })).pipe(
      Stream.runDrain,
      Effect.flip,
    );

    expect(error.detail).toBe("Amp turn was cancelled.");
    expect(kills).toBe(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

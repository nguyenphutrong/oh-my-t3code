import type { ChatImageAttachment } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;

const AmpUsage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  cache_creation_input_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.Number),
});

const AmpAssistantContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_use"),
    id: Schema.String,
    name: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String }),
  Schema.Struct({ type: Schema.Literal("redacted_thinking"), data: Schema.String }),
]);

const AmpCliMessageSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("init"),
    session_id: Schema.String,
    cwd: Schema.String,
    tools: Schema.Array(Schema.String),
    mcp_servers: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
    agent_mode: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literals(["error_max_turns", "error_during_execution"]),
    session_id: Schema.String,
    error: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("assistant"),
    session_id: Schema.String,
    parent_tool_use_id: Schema.NullOr(Schema.String),
    message: Schema.Struct({
      id: Schema.optional(Schema.String),
      type: Schema.Literal("message"),
      role: Schema.Literal("assistant"),
      model: Schema.optional(Schema.String),
      content: Schema.Array(AmpAssistantContent),
      stop_reason: Schema.NullOr(Schema.String),
      stop_sequence: Schema.optional(Schema.NullOr(Schema.String)),
      usage: Schema.optional(AmpUsage),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("user"),
    session_id: Schema.String,
    parent_tool_use_id: Schema.NullOr(Schema.String),
    message: Schema.Struct({
      role: Schema.Literal("user"),
      content: Schema.Array(
        Schema.Union([
          Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
          Schema.Struct({
            type: Schema.Literal("tool_result"),
            tool_use_id: Schema.String,
            content: Schema.String,
            is_error: Schema.Boolean,
          }),
        ]),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    subtype: Schema.Literals(["success", "error_during_execution", "error_max_turns"]),
    is_error: Schema.Boolean,
    session_id: Schema.String,
    duration_ms: Schema.Number,
    num_turns: Schema.Number,
    result: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
    usage: Schema.optional(AmpUsage),
    permission_denials: Schema.optional(Schema.Array(Schema.String)),
  }),
]);

const AmpThreadExportSchema = Schema.Struct({
  created: Schema.Union([Schema.String, Schema.Number]),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant", "info"]),
      protocolMessageID: Schema.String,
      createdAt: Schema.optional(Schema.NullOr(Schema.String)),
      content: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          text: Schema.optional(Schema.String),
          hidden: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
});

const AmpSettingsFileSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeAmpCliMessage = Schema.decodeUnknownSync(Schema.fromJsonString(AmpCliMessageSchema));
const decodeAmpThreadExport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AmpThreadExportSchema),
);
const decodeAmpSettingsFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AmpSettingsFileSchema),
);
const encodeAmpInput = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeAmpSettingsFile = Schema.encodeSync(Schema.fromJsonString(AmpSettingsFileSchema));

export type AmpCliMessage = typeof AmpCliMessageSchema.Type;
export type AmpCliUsage = typeof AmpUsage.Type;

export interface AmpThreadHistoryMessage {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface AmpCliImageInput {
  readonly type: "image";
  readonly source: {
    readonly type: "base64";
    readonly media_type: ChatImageAttachment["mimeType"];
    readonly data: string;
  };
}

export interface AmpCliUserMessage {
  readonly type: "user";
  readonly requestId?: string | undefined;
  readonly message: {
    readonly role: "user";
    readonly content: ReadonlyArray<
      { readonly type: "text"; readonly text: string } | AmpCliImageInput
    >;
  };
}

export interface AmpCliExecuteInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly message: AmpCliUserMessage;
  readonly mode: string;
  readonly effort?: string | undefined;
  readonly fastMode?: boolean | undefined;
  readonly continueThreadId?: string | undefined;
  readonly settingsFile?: string | undefined;
  readonly dangerouslyAllowAll?: boolean | undefined;
  readonly denyTools?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class AmpCliRuntimeError extends Data.TaggedError("AmpCliRuntimeError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export type AmpCliExecute = (
  input: AmpCliExecuteInput,
) => Stream.Stream<AmpCliMessage, AmpCliRuntimeError>;

export interface AmpCliExportThreadInput {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly threadId: string;
  readonly settingsFile?: string | undefined;
}

export type AmpCliExportThread = (
  input: AmpCliExportThreadInput,
) => Effect.Effect<ReadonlyArray<AmpThreadHistoryMessage>, AmpCliRuntimeError>;

function executionError(detail: string, cause?: unknown): AmpCliRuntimeError {
  return new AmpCliRuntimeError({ detail, ...(cause === undefined ? {} : { cause }) });
}

function parseMessage(line: string): AmpCliMessage {
  if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
    throw executionError("Amp returned a message larger than 1 MiB.");
  }
  try {
    return decodeAmpCliMessage(line);
  } catch (cause) {
    throw executionError("Amp returned an invalid streaming JSON message.", cause);
  }
}

function cliArgs(input: AmpCliExecuteInput, settingsFile: string | undefined): string[] {
  const args = input.continueThreadId ? ["threads", "continue", input.continueThreadId] : [];
  args.push("--execute", "--stream-json-thinking", "--stream-json-input");
  args.push("--plugin-ready-timeout", "10");
  if (input.fastMode) args.push("--fast");
  if (input.dangerouslyAllowAll) args.push("--dangerously-allow-all");
  args.push("--no-archive-after-execute", "--visibility", "private");
  if (settingsFile) args.push("--settings-file", settingsFile);
  if (input.mode) args.push("--mode", input.mode);
  if (input.effort) args.push("--effort", input.effort);
  return args;
}

const prepareSettingsFile = Effect.fn("AmpCliRuntime.prepareSettingsFile")(function* (
  input: AmpCliExecuteInput,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  if (!input.denyTools) return input.settingsFile;

  let settings: Record<string, unknown> = {};
  if (input.settingsFile) {
    const source = yield* fs
      .readFileString(input.settingsFile)
      .pipe(
        Effect.mapError((cause) =>
          executionError("Could not read the configured Amp settings file.", cause),
        ),
      );
    settings = yield* decodeAmpSettingsFile(source).pipe(
      Effect.map((parsed) => ({ ...parsed })),
      Effect.mapError((cause) =>
        executionError("The configured Amp settings file is not a valid JSON object.", cause),
      ),
    );
  }
  settings["amp.permissions"] = [{ tool: "*", action: "reject" }];
  settings["amp.dangerouslyAllowAll"] = false;

  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-amp-cli-" })
    .pipe(
      Effect.mapError((cause) => executionError("Could not create Amp temporary settings.", cause)),
    );
  const settingsFile = path.join(directory, "settings.json");
  yield* fs.writeFileString(settingsFile, encodeAmpSettingsFile(settings)).pipe(
    Effect.andThen(fs.chmod(settingsFile, 0o600)),
    Effect.mapError((cause) => executionError("Could not write Amp temporary settings.", cause)),
  );
  return settingsFile;
});

export const makeAmpCliExecute = Effect.fn("makeAmpCliExecute")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return ((input) =>
    Stream.callback<AmpCliMessage, AmpCliRuntimeError>((output) =>
      Effect.gen(function* () {
        const settingsFile = yield* prepareSettingsFile(input, fs, path);
        const args = cliArgs(input, settingsFile);
        const resolved = yield* resolveSpawnCommand(input.binaryPath || "amp", args, {
          env: input.environment,
        }).pipe(
          Effect.mapError((cause) => executionError("Could not resolve the Amp CLI.", cause)),
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              cwd: input.cwd,
              env: input.environment,
              shell: resolved.shell,
            }),
          )
          .pipe(Effect.mapError((cause) => executionError("Could not start the Amp CLI.", cause)));
        yield* Effect.addFinalizer(() =>
          child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore),
        );

        const stdin = `${encodeAmpInput({
          type: input.message.type,
          request_id: input.message.requestId,
          message: input.message.message,
        })}\n`;

        const run = Effect.gen(function* () {
          let buffered = "";
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const consumeStdout = child.stdout.pipe(
            Stream.runForEach((chunk) =>
              Effect.try({
                try: () => {
                  buffered += decoder.decode(chunk, { stream: true });
                  const messages: AmpCliMessage[] = [];
                  while (true) {
                    const newline = buffered.indexOf("\n");
                    if (newline === -1) break;
                    const line = buffered.slice(0, newline).replace(/\r$/u, "").trim();
                    buffered = buffered.slice(newline + 1);
                    if (line) messages.push(parseMessage(line));
                  }
                  if (Buffer.byteLength(buffered, "utf8") > MAX_MESSAGE_BYTES) {
                    throw executionError("Amp returned a message larger than 1 MiB.");
                  }
                  return messages;
                },
                catch: (cause) =>
                  cause instanceof AmpCliRuntimeError
                    ? cause
                    : executionError("Amp returned invalid UTF-8 output.", cause),
              }).pipe(Effect.flatMap((messages) => Queue.offerAll(output, messages))),
            ),
            Effect.flatMap(() =>
              Effect.try({
                try: () => {
                  buffered += decoder.decode();
                  const line = buffered.replace(/\r$/u, "").trim();
                  return line ? [parseMessage(line)] : [];
                },
                catch: (cause) =>
                  cause instanceof AmpCliRuntimeError
                    ? cause
                    : executionError("Amp returned invalid UTF-8 output.", cause),
              }),
            ),
            Effect.flatMap((messages) => Queue.offerAll(output, messages)),
          );
          const writeStdin = Stream.run(Stream.encodeText(Stream.make(stdin)), child.stdin).pipe(
            Effect.mapError((cause) =>
              executionError("Could not send input to the Amp CLI.", cause),
            ),
          );
          const [exitCode, stderr] = yield* Effect.all(
            [
              child.exitCode,
              collectUint8StreamText({ stream: child.stderr, maxBytes: MAX_STDERR_BYTES }),
              writeStdin,
              consumeStdout,
            ],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map(([code, errorOutput]) => [Number(code), errorOutput.text] as const),
            Effect.mapError((cause) =>
              cause instanceof AmpCliRuntimeError
                ? cause
                : executionError("Amp CLI execution failed.", cause),
            ),
          );
          if (exitCode !== 0) {
            const detail = /auth|login|unauthorized|credential/iu.test(stderr)
              ? "Amp authentication is required. Run `amp login` and try again."
              : `Amp CLI exited with code ${exitCode}.`;
            return yield* executionError(detail);
          }
        });

        const awaitAbort = input.signal
          ? Effect.callback<never, AmpCliRuntimeError>((resume) => {
              const abort = () => resume(Effect.fail(executionError("Amp turn was cancelled.")));
              if (input.signal!.aborted) {
                abort();
                return;
              }
              input.signal!.addEventListener("abort", abort, { once: true });
              return Effect.sync(() => input.signal!.removeEventListener("abort", abort));
            })
          : Effect.never;
        yield* Effect.raceFirst(run, awaitAbort).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => Queue.failCause(output, cause),
            onSuccess: () => Queue.end(output),
          }),
          Effect.forkScoped,
        );
      }),
    )) satisfies AmpCliExecute;
});

export const makeAmpCliExportThread = Effect.fn("makeAmpCliExportThread")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return ((input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const args = ["threads", "export", input.threadId];
        if (input.settingsFile) args.push("--settings-file", input.settingsFile);
        const resolved = yield* resolveSpawnCommand(input.binaryPath || "amp", args, {
          env: input.environment,
        }).pipe(
          Effect.mapError((cause) => executionError("Could not resolve the Amp CLI.", cause)),
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              cwd: input.cwd,
              env: input.environment,
              shell: resolved.shell,
            }),
          )
          .pipe(Effect.mapError((cause) => executionError("Could not start the Amp CLI.", cause)));

        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            child.exitCode,
            collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_EXPORT_BYTES }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: MAX_STDERR_BYTES }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError((cause) => executionError("Amp thread export failed.", cause)));
        if (Number(exitCode) !== 0) {
          return yield* executionError(
            /auth|login|unauthorized|credential/iu.test(stderr.text)
              ? "Amp authentication is required. Run `amp login` and try again."
              : `Amp CLI exited with code ${Number(exitCode)} while exporting thread history.`,
          );
        }
        if (stdout.truncated || stdout.invalidUtf8) {
          return yield* executionError("Amp returned an invalid or oversized thread export.");
        }
        const exported = yield* decodeAmpThreadExport(stdout.text).pipe(
          Effect.mapError((cause) =>
            executionError("Amp returned an invalid thread export.", cause),
          ),
        );
        const createdAt =
          typeof exported.created === "number"
            ? DateTime.formatIso(DateTime.makeUnsafe(exported.created))
            : exported.created;
        return exported.messages.flatMap((message): AmpThreadHistoryMessage[] => {
          if (message.role === "info") return [];
          const text = message.content
            .filter((content) => content.type === "text" && content.hidden !== true)
            .flatMap((content) => (content.text === undefined ? [] : [content.text]))
            .join("");
          if (!text.trim()) return [];
          return [
            {
              messageId: message.protocolMessageID,
              role: message.role,
              text,
              createdAt: message.createdAt ?? createdAt,
            },
          ];
        });
      }),
    )) satisfies AmpCliExportThread;
});

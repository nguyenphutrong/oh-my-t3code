import {
  EventId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  type ThreadId,
  TurnId,
  type CanonicalItemType,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  makeAmpCliExportThread,
  makeAmpCliExecute,
  type AmpCliExportThread,
  type AmpCliExecute,
  type AmpCliImageInput,
  type AmpCliMessage,
  type AmpCliUsage,
} from "./AmpCliRuntime.ts";

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

export interface AmpAdapterConfig {
  readonly binaryPath: string;
  readonly settingsFile?: string | undefined;
}

export interface AmpAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly attachmentsDir: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execute?: AmpCliExecute;
  readonly exportThread?: AmpCliExportThread;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly lock: Semaphore.Semaphore;
  session: ProviderSession;
  ampThreadId: string | undefined;
  effort: string | undefined;
  activeTurnId: TurnId | undefined;
  abortController: AbortController | undefined;
  stopped: boolean;
}

const DRIVER_KIND = ProviderDriverKind.make("amp");
const RESUME_VERSION = 1;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_EVENT_FIELD_CHARS = 256 * 1024;
const VALID_MODES = new Set(["low", "medium", "high", "ultra"]);
const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isAdapterError(value: unknown): value is ProviderAdapterError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    [
      "ProviderAdapterValidationError",
      "ProviderAdapterRequestError",
      "ProviderAdapterSessionNotFoundError",
      "ProviderAdapterSessionClosedError",
      "ProviderAdapterProcessError",
    ].includes(String(value._tag))
  );
}

function resumeThreadId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === RESUME_VERSION &&
    typeof record.threadId === "string" &&
    record.threadId.trim()
    ? record.threadId.trim()
    : undefined;
}

function serializedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return MAX_MESSAGE_BYTES + 1;
  }
}

function boundedText(value: string): string {
  return value.length <= MAX_EVENT_FIELD_CHARS
    ? value
    : `${value.slice(0, MAX_EVENT_FIELD_CHARS)}\n[truncated by T3 Code]`;
}

function boundedData(value: unknown): unknown {
  return serializedSize(value) <= MAX_EVENT_FIELD_CHARS
    ? value
    : { truncated: true, reason: "Amp tool payload exceeded the T3 Code event limit." };
}

function toolItemType(name: string): CanonicalItemType {
  const normalized = name.toLowerCase();
  if (/bash|shell|terminal|command|exec/u.test(normalized)) return "command_execution";
  if (/edit|write|patch|delete|move|rename/u.test(normalized)) return "file_change";
  if (/task|subagent|delegate/u.test(normalized)) return "collab_agent_tool_call";
  if (/^mcp|mcp__/u.test(normalized)) return "mcp_tool_call";
  if (/web|search|fetch|browser/u.test(normalized)) return "web_search";
  if (/image|screenshot/u.test(normalized)) return "image_view";
  return "dynamic_tool_call";
}

function tokenUsage(usage: AmpCliUsage | undefined) {
  if (!usage) return undefined;
  return {
    usageStatus: "complete" as const,
    usageScope: "main_agent" as const,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens !== undefined
      ? { cachedInputTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cacheCreationTokens: usage.cache_creation_input_tokens }
      : {}),
    hasSubagents: false,
  };
}

function safeErrorDetail(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "AmpCliRuntimeError" &&
    "detail" in error &&
    typeof error.detail === "string"
  )
    return boundedText(error.detail);
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|cancel/iu.test(message)) return "Amp turn was cancelled.";
  if (/auth|login|unauthorized|credential/iu.test(message))
    return "Amp authentication is required. Run `amp login` and try again.";
  if (/not found|enoent|could not find amp/iu.test(message))
    return "Amp CLI was not found. Install Amp or configure its binary path.";
  return "Amp execution failed. Check the provider health details and server logs.";
}

export const makeAmpAdapter = Effect.fn("makeAmpAdapter")(function* (
  config: AmpAdapterConfig,
  options: AmpAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, SessionContext>();
  const execute = options.execute ?? (yield* makeAmpCliExecute());
  const exportThread = options.exportThread ?? (yield* makeAmpCliExportThread());

  const stamp = Effect.all({
    eventId: Effect.map(crypto.randomUUIDv4, EventId.make),
    createdAt: Effect.map(DateTime.now, DateTime.formatIso),
  }).pipe(
    Effect.map((value) => ({ ...value, providerInstanceId: options.instanceId })),
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: DRIVER_KIND,
          method: "event/stamp",
          detail: "Could not create an Amp runtime event.",
          cause,
        }),
    ),
  );
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: DRIVER_KIND, threadId }));
  };

  const startSession: Adapter["startSession"] = (input) =>
    Effect.gen(function* () {
      if (
        (input.provider && input.provider !== DRIVER_KIND) ||
        (input.providerInstanceId && input.providerInstanceId !== options.instanceId) ||
        (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
      )
        return yield* new ProviderAdapterValidationError({
          provider: DRIVER_KIND,
          operation: "startSession",
          issue: "Provider instance does not match this Amp adapter.",
        });
      if (!input.cwd?.trim())
        return yield* new ProviderAdapterValidationError({
          provider: DRIVER_KIND,
          operation: "startSession",
          issue: "A workspace directory is required.",
        });
      const savedThreadId = resumeThreadId(input.resumeCursor);
      if (input.resumeCursor !== undefined && !savedThreadId)
        return yield* new ProviderAdapterValidationError({
          provider: DRIVER_KIND,
          operation: "startSession",
          issue: "The saved Amp thread cursor is invalid.",
        });
      const cwd = path.resolve(input.cwd);
      const info = yield* fs.stat(cwd).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterValidationError({
              provider: DRIVER_KIND,
              operation: "startSession",
              issue: "Workspace directory does not exist.",
              cause,
            }),
        ),
      );
      if (info.type !== "Directory")
        return yield* new ProviderAdapterValidationError({
          provider: DRIVER_KIND,
          operation: "startSession",
          issue: "Workspace path is not a directory.",
        });
      const existing = sessions.get(input.threadId);
      if (existing) {
        existing.stopped = true;
        existing.abortController?.abort();
        sessions.delete(input.threadId);
      }
      const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const requestedMode = input.modelSelection?.model ?? "medium";
      if (!VALID_MODES.has(requestedMode))
        return yield* new ProviderAdapterValidationError({
          provider: DRIVER_KIND,
          operation: "startSession",
          issue: `Unsupported Amp mode: ${requestedMode}.`,
        });
      const requestedEffort = getProviderOptionStringSelectionValue(
        input.modelSelection?.options,
        "reasoningEffort",
      );
      if (requestedEffort && !VALID_EFFORTS.has(requestedEffort))
        return yield* new ProviderAdapterValidationError({
          provider: DRIVER_KIND,
          operation: "startSession",
          issue: `Unsupported Amp reasoning effort: ${requestedEffort}.`,
        });
      const session: ProviderSession = {
        provider: DRIVER_KIND,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        model: requestedMode,
        threadId: input.threadId,
        ...(savedThreadId
          ? { resumeCursor: { schemaVersion: RESUME_VERSION, threadId: savedThreadId } }
          : {}),
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(input.threadId, {
        threadId: input.threadId,
        lock: yield* Semaphore.make(1),
        session,
        ampThreadId: savedThreadId,
        effort: requestedEffort,
        activeTurnId: undefined,
        abortController: undefined,
        stopped: false,
      });
      yield* emit({
        type: "session.started",
        ...(yield* stamp),
        provider: DRIVER_KIND,
        threadId: input.threadId,
        payload: savedThreadId ? { resume: { threadId: savedThreadId } } : {},
      });
      if (savedThreadId)
        yield* emit({
          type: "thread.started",
          ...(yield* stamp),
          provider: DRIVER_KIND,
          threadId: input.threadId,
          payload: { providerThreadId: savedThreadId },
        });
      if (savedThreadId) {
        const history = yield* exportThread({
          binaryPath: config.binaryPath,
          cwd,
          environment: options.environment ?? process.env,
          threadId: savedThreadId,
          ...(config.settingsFile?.trim()
            ? { settingsFile: expandHomePath(config.settingsFile.trim()) }
            : {}),
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not sync Amp thread history", {
              ampThreadId: savedThreadId,
              cause,
            }).pipe(Effect.as([])),
          ),
        );
        if (history.length > 0)
          yield* emit({
            type: "thread.history.synced",
            ...(yield* stamp),
            provider: DRIVER_KIND,
            threadId: input.threadId,
            payload: {
              messages: history.map((message) => ({
                ...message,
                messageId: `import:amp:${savedThreadId}:${message.messageId}`,
              })),
            },
          });
      }
      return session;
    });

  const processMessage = (
    context: SessionContext,
    turnId: TurnId,
    message: AmpCliMessage,
    activeTools: Map<string, CanonicalItemType>,
    assistantTexts: Set<string>,
  ) =>
    Effect.gen(function* () {
      if (serializedSize(message) > MAX_MESSAGE_BYTES)
        return yield* new ProviderAdapterRequestError({
          provider: DRIVER_KIND,
          method: "amp/stream",
          detail: "Amp returned a message larger than 1 MiB.",
        });
      if (message.type === "system") {
        if (message.subtype !== "init")
          return yield* new ProviderAdapterRequestError({
            provider: DRIVER_KIND,
            method: "amp/stream",
            detail: boundedText(message.error),
          });
        if (context.ampThreadId && context.ampThreadId !== message.session_id)
          return yield* new ProviderAdapterRequestError({
            provider: DRIVER_KIND,
            method: "amp/initialize",
            detail: "Amp resumed a different thread than requested.",
          });
        if (!context.ampThreadId) {
          context.ampThreadId = message.session_id;
          context.session = {
            ...context.session,
            resumeCursor: { schemaVersion: RESUME_VERSION, threadId: message.session_id },
          };
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: DRIVER_KIND,
            threadId: context.threadId,
            turnId,
            payload: { providerThreadId: message.session_id },
          });
        }
        return;
      }
      if (message.type === "assistant") {
        const messageText = message.message.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("");
        if (messageText.trim()) assistantTexts.add(messageText.trim());
        for (const [index, content] of message.message.content.entries()) {
          if (content.type === "text" || content.type === "thinking") {
            const itemId = RuntimeItemId.make(
              `${message.message.id ?? `${turnId}:assistant`}:${content.type}:${index}`,
            );
            const itemType = content.type === "text" ? "assistant_message" : "reasoning";
            yield* emit({
              type: "item.started",
              ...(yield* stamp),
              provider: DRIVER_KIND,
              threadId: context.threadId,
              turnId,
              itemId,
              payload: { itemType, status: "inProgress" },
            });
            yield* emit({
              type: "content.delta",
              ...(yield* stamp),
              provider: DRIVER_KIND,
              threadId: context.threadId,
              turnId,
              itemId,
              payload: {
                streamKind: content.type === "text" ? "assistant_text" : "reasoning_text",
                delta: boundedText(content.type === "text" ? content.text : content.thinking),
              },
            });
            yield* emit({
              type: "item.completed",
              ...(yield* stamp),
              provider: DRIVER_KIND,
              threadId: context.threadId,
              turnId,
              itemId,
              payload: { itemType, status: "completed" },
            });
          } else if (content.type === "tool_use") {
            const itemType = toolItemType(content.name);
            activeTools.set(content.id, itemType);
            yield* emit({
              type: "item.started",
              ...(yield* stamp),
              provider: DRIVER_KIND,
              threadId: context.threadId,
              turnId,
              itemId: RuntimeItemId.make(content.id),
              payload: {
                itemType,
                status: "inProgress",
                title: content.name,
                data: boundedData(content.input),
                ...(message.parent_tool_use_id
                  ? { parentToolUseId: message.parent_tool_use_id }
                  : {}),
              },
            });
          }
        }
        return;
      }
      if (message.type === "user") {
        for (const content of message.message.content) {
          if (content.type !== "tool_result") continue;
          const itemType = activeTools.get(content.tool_use_id);
          if (!itemType) continue;
          activeTools.delete(content.tool_use_id);
          yield* emit({
            type: "item.completed",
            ...(yield* stamp),
            provider: DRIVER_KIND,
            threadId: context.threadId,
            turnId,
            itemId: RuntimeItemId.make(content.tool_use_id),
            payload: {
              itemType,
              status: content.is_error ? "failed" : "completed",
              detail: boundedText(content.content),
              ...(message.parent_tool_use_id
                ? { parentToolUseId: message.parent_tool_use_id }
                : {}),
            },
          });
        }
        return;
      }
      if (message.type === "result") {
        const failed = message.is_error || (message.permission_denials?.length ?? 0) > 0;
        for (const [toolUseId, itemType] of activeTools) {
          yield* emit({
            type: "item.completed",
            ...(yield* stamp),
            provider: DRIVER_KIND,
            threadId: context.threadId,
            turnId,
            itemId: RuntimeItemId.make(toolUseId),
            payload: { itemType, status: failed ? "failed" : "completed" },
          });
        }
        activeTools.clear();
        for (const denial of message.permission_denials ?? [])
          yield* emit({
            type: "tool.denied",
            ...(yield* stamp),
            provider: DRIVER_KIND,
            threadId: context.threadId,
            turnId,
            payload: { toolName: "Amp tool", reason: boundedText(denial) },
          });
        const resultText = message.result?.trim();
        if (!failed && resultText && !assistantTexts.has(resultText)) {
          const itemId = RuntimeItemId.make(`${turnId}:result`);
          yield* emit({
            type: "item.started",
            ...(yield* stamp),
            provider: DRIVER_KIND,
            threadId: context.threadId,
            turnId,
            itemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
          yield* emit({
            type: "content.delta",
            ...(yield* stamp),
            provider: DRIVER_KIND,
            threadId: context.threadId,
            turnId,
            itemId,
            payload: { streamKind: "assistant_text", delta: boundedText(resultText) },
          });
          yield* emit({
            type: "item.completed",
            ...(yield* stamp),
            provider: DRIVER_KIND,
            threadId: context.threadId,
            turnId,
            itemId,
            payload: { itemType: "assistant_message", status: "completed" },
          });
        }
      }
    });

  const resolveImageInput = Effect.fn("AmpAdapter.resolveImageInput")(function* (
    attachment: NonNullable<Parameters<Adapter["sendTurn"]>[0]["attachments"]>[number],
  ) {
    // Generic files reach Amp through the safe local path ProviderService adds
    // to the prompt. Only images have a native stream-json input block.
    if (attachment.type !== "image") return undefined;
    if (!isProviderSendTurnSupportedImageMimeType(attachment.mimeType))
      return yield* new ProviderAdapterValidationError({
        provider: DRIVER_KIND,
        operation: "sendTurn",
        issue: `Amp does not support image type '${attachment.mimeType}'.`,
      });
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: options.attachmentsDir,
      attachment,
    });
    if (!attachmentPath)
      return yield* new ProviderAdapterValidationError({
        provider: DRIVER_KIND,
        operation: "sendTurn",
        issue: `Invalid attachment id '${attachment.id}'.`,
      });
    const bytes = yield* fs.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: DRIVER_KIND,
            method: "amp/attachment",
            detail: `Failed to read attachment '${attachment.name}'.`,
            cause,
          }),
      ),
    );
    if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
      return yield* new ProviderAdapterValidationError({
        provider: DRIVER_KIND,
        operation: "sendTurn",
        issue: `Attachment '${attachment.name}' is empty or larger than 10 MiB.`,
      });
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mimeType,
        data: Buffer.from(bytes).toString("base64"),
      },
    } satisfies AmpCliImageInput;
  });

  const sendTurn: Adapter["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
        return yield* new ProviderAdapterValidationError({
          provider: DRIVER_KIND,
          operation: "sendTurn",
          issue: "Selected model belongs to another provider instance.",
        });
      const text = input.input?.trim();
      const imageInputs = (yield* Effect.forEach(input.attachments ?? [], resolveImageInput, {
        concurrency: 1,
      })).filter((attachment): attachment is AmpCliImageInput => attachment !== undefined);
      if (!text && imageInputs.length === 0)
        return yield* new ProviderAdapterValidationError({
          provider: DRIVER_KIND,
          operation: "sendTurn",
          issue: "Amp turns require text or a supported image attachment.",
        });
      return yield* context.lock.withPermit(
        Effect.gen(function* () {
          const mode = input.modelSelection?.model ?? context.session.model ?? "medium";
          if (!VALID_MODES.has(mode))
            return yield* new ProviderAdapterValidationError({
              provider: DRIVER_KIND,
              operation: "sendTurn",
              issue: `Unsupported Amp mode: ${mode}.`,
            });
          const effort =
            getProviderOptionStringSelectionValue(
              input.modelSelection?.options,
              "reasoningEffort",
            ) ?? context.effort;
          if (effort && !VALID_EFFORTS.has(effort))
            return yield* new ProviderAdapterValidationError({
              provider: DRIVER_KIND,
              operation: "sendTurn",
              issue: `Unsupported Amp reasoning effort: ${effort}.`,
            });
          context.effort = effort;
          const turnId = TurnId.make(yield* crypto.randomUUIDv4);
          const abortController = new AbortController();
          context.activeTurnId = turnId;
          context.abortController = abortController;
          context.session = {
            ...context.session,
            status: "running",
            model: mode,
            activeTurnId: turnId,
            updatedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
          };
          yield* emit({
            type: "turn.started",
            ...(yield* stamp),
            provider: DRIVER_KIND,
            threadId: input.threadId,
            turnId,
            payload: { model: mode, ...(effort ? { effort } : {}) },
          });
          return yield* Effect.gen(function* () {
            const execution = {
              binaryPath: config.binaryPath,
              cwd: context.session.cwd!,
              environment: options.environment ?? process.env,
              message: {
                type: "user" as const,
                requestId: turnId,
                message: {
                  role: "user" as const,
                  content: [...(text ? [{ type: "text" as const, text }] : []), ...imageInputs],
                },
              },
              mode,
              ...(effort ? { effort } : {}),
              ...(context.ampThreadId ? { continueThreadId: context.ampThreadId } : {}),
              ...(config.settingsFile?.trim()
                ? { settingsFile: expandHomePath(config.settingsFile.trim()) }
                : {}),
              dangerouslyAllowAll: context.session.runtimeMode === "full-access",
              signal: abortController.signal,
            };
            const activeTools = new Map<string, CanonicalItemType>();
            const assistantTexts = new Set<string>();
            let result: Extract<AmpCliMessage, { type: "result" }> | undefined;
            yield* execute(execution).pipe(
              Stream.runForEach((message) =>
                processMessage(context, turnId, message, activeTools, assistantTexts).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (message.type === "result") result = message;
                    }),
                  ),
                ),
              ),
              Effect.mapError((cause) =>
                isAdapterError(cause)
                  ? cause
                  : new ProviderAdapterRequestError({
                      provider: DRIVER_KIND,
                      method: "amp/stream",
                      detail: safeErrorDetail(cause),
                      cause,
                    }),
              ),
            );
            if (!result)
              return yield* new ProviderAdapterRequestError({
                provider: DRIVER_KIND,
                method: "amp/stream",
                detail: "Amp exited before returning a result.",
              });
            if (result.is_error)
              return yield* new ProviderAdapterRequestError({
                provider: DRIVER_KIND,
                method: "amp/execute",
                detail: boundedText(result.error ?? "Amp execution failed."),
              });
            context.session = {
              ...context.session,
              status: "ready",
              activeTurnId: undefined,
              resumeCursor: context.ampThreadId
                ? { schemaVersion: RESUME_VERSION, threadId: context.ampThreadId }
                : undefined,
              updatedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
            };
            yield* emit({
              type: "turn.completed",
              ...(yield* stamp),
              provider: DRIVER_KIND,
              threadId: input.threadId,
              turnId,
              payload: {
                state: "completed",
                stopReason: "end_turn",
                ...(tokenUsage(result.usage) ? { tokenUsage: tokenUsage(result.usage) } : {}),
              },
            });
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: context.session.resumeCursor,
            };
          }).pipe(
            Effect.onError((cause) =>
              Effect.gen(function* () {
                const cancelled = abortController.signal.aborted;
                const detail = cancelled ? "Amp turn was cancelled." : safeErrorDetail(cause);
                context.session = {
                  ...context.session,
                  status: cancelled ? "ready" : "error",
                  activeTurnId: undefined,
                  lastError: cancelled ? undefined : detail,
                  updatedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
                };
                yield* emit({
                  type: "turn.completed",
                  ...(yield* stamp),
                  provider: DRIVER_KIND,
                  threadId: input.threadId,
                  turnId,
                  payload: cancelled
                    ? { state: "cancelled", stopReason: "cancelled" }
                    : { state: "failed", errorMessage: detail },
                });
              }).pipe(Effect.ignore),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                context.activeTurnId = undefined;
                context.abortController = undefined;
              }),
            ),
          );
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isAdapterError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: DRIVER_KIND,
              method: "amp/execute",
              detail: safeErrorDetail(cause),
              cause,
            }),
      ),
    );

  const stopSession: Adapter["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      context.stopped = true;
      context.abortController?.abort();
      sessions.delete(threadId);
      yield* emit({
        type: "session.exited",
        ...(yield* stamp),
        provider: DRIVER_KIND,
        threadId,
        payload: { exitKind: "graceful" },
      });
    });
  const stopAll = () =>
    Effect.forEach([...sessions.keys()], stopSession, { discard: true }).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ensuring(PubSub.shutdown(events))));

  return {
    provider: DRIVER_KIND,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn: (threadId) =>
      Effect.flatMap(requireSession(threadId), (context) =>
        Effect.sync(() => context.abortController?.abort()),
      ),
    respondToRequest: (threadId) =>
      Effect.andThen(
        requireSession(threadId),
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: DRIVER_KIND,
            operation: "respondToRequest",
            issue: "Amp has no pending T3 Code permission request.",
          }),
        ),
      ),
    respondToUserInput: (threadId, _requestId, _answers: ProviderUserInputAnswers) =>
      Effect.andThen(
        requireSession(threadId),
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: DRIVER_KIND,
            operation: "respondToUserInput",
            issue: "The Amp CLI streaming protocol does not support structured user input.",
          }),
        ),
      ),
    stopSession,
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({
            ...context.session,
          })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => !!sessions.get(threadId) && !sessions.get(threadId)!.stopped),
    readThread: (threadId) =>
      Effect.andThen(
        requireSession(threadId),
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: DRIVER_KIND,
            operation: "readThread",
            issue: "The Amp CLI streaming protocol does not provide a conversation snapshot.",
          }),
        ),
      ),
    rollbackThread: (threadId) =>
      Effect.andThen(
        requireSession(threadId),
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: DRIVER_KIND,
            operation: "rollbackThread",
            issue: "The Amp CLI streaming protocol does not support conversation rewind.",
          }),
        ),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { acpReadTextFile, acpWriteTextFile } from "../acp/AcpClientFs.ts";
import { makeAcpClientTerminals, type AcpClientTerminals } from "../acp/AcpClientTerminals.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest, type AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type Adapter = ProviderAdapterShape<ProviderAdapterError>;

export interface GenericAcpRuntimeInput {
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly resumeMethod?: "load" | "resume";
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
}

export interface GenericAcpAdapterOptions {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly makeRuntime: (
    input: GenericAcpRuntimeInput,
  ) => Effect.Effect<Runtime, EffectAcpErrors.AcpError, Scope.Scope>;
  readonly mcpServers?: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<EffectAcpSchema.McpServer>, ProviderAdapterError>;
  /** Environment inherited by terminals the ACP agent asks T3 Code to spawn. */
  readonly terminalEnvironment?: NodeJS.ProcessEnv;
}

interface PendingApproval {
  readonly request: EffectAcpSchema.RequestPermissionRequest;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly nativeSessionId: string;
  readonly runtime: Runtime;
  readonly scope: Scope.Closeable;
  readonly lock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly terminals: AcpClientTerminals;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  stopped: boolean;
  disconnected: boolean;
}

const RESUME_VERSION = 1;
const MAX_CLIENT_FILE_BYTES = 8 * 1024 * 1024;
const isAcpError = Schema.is(EffectAcpErrors.AcpError);
const isAdapterError = (value: unknown): value is ProviderAdapterError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  [
    "ProviderAdapterValidationError",
    "ProviderAdapterRequestError",
    "ProviderAdapterSessionNotFoundError",
    "ProviderAdapterSessionClosedError",
    "ProviderAdapterProcessError",
  ].includes(String(value._tag));

function resumeId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === RESUME_VERSION &&
    typeof record.sessionId === "string" &&
    record.sessionId.trim()
    ? record.sessionId.trim()
    : undefined;
}

function selectedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  const wanted =
    decision === "acceptForSession"
      ? ["allow_always", "allow_once"]
      : decision === "accept"
        ? ["allow_once", "allow_always"]
        : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option?.optionId.trim()) return option.optionId;
  }
  return undefined;
}

function requestedModeId(
  state: AcpSessionModeState | undefined,
  runtimeMode: ProviderSession["runtimeMode"],
  interactionMode: "default" | "plan" | undefined,
): string | undefined {
  if (!state) return undefined;
  const aliases =
    interactionMode === "plan"
      ? ["plan"]
      : runtimeMode === "approval-required"
        ? ["ask", "approval", "default", "implement"]
        : ["auto", "accept", "yolo", "implement", "default"];
  return aliases
    .map((alias) =>
      state.availableModes.find((mode) => `${mode.id} ${mode.name}`.toLowerCase().includes(alias)),
    )
    .find((mode) => mode !== undefined)?.id;
}

/** A provider-neutral ACP adapter. Provider-specific protocol extensions belong in a flavor adapter. */
export const makeGenericAcpAdapter = Effect.fn("makeGenericAcpAdapter")(function* (
  options: GenericAcpAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Effect.scope;
  const sessions = new Map<ThreadId, SessionContext>();
  const threadLocks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const stamp = Effect.all({
    eventId: Effect.map(crypto.randomUUIDv4, EventId.make),
    createdAt: Effect.map(DateTime.now, DateTime.formatIso),
  });
  // A shutting-down subscriber cannot be allowed to fail a provider process or another session.
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.ignore);
  const mapError = (threadId: ThreadId, method: string, error: EffectAcpErrors.AcpError) =>
    mapAcpToAdapterError(options.provider, threadId, method, error);
  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(threadLocks, (current) => {
      const found = current.get(threadId);
      return found
        ? Effect.succeed([found, current] as const)
        : Semaphore.make(1).pipe(
            Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
          );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(effect)));
  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: options.provider, threadId }),
        );
  };

  const cancelApprovals = (context: SessionContext) =>
    Effect.forEach(
      [...context.approvals.values()],
      (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
      { discard: true },
    );

  const stopContext = (context: SessionContext) =>
    context.lock
      .withPermit(
        Effect.gen(function* () {
          if (context.stopped && !sessions.has(context.threadId)) return;
          context.stopped = true;
          yield* cancelApprovals(context);
          if (context.promptFiber && !context.disconnected)
            yield* Effect.ignore(context.runtime.cancel);
          yield* context.terminals.disposeAll;
          yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
          if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          yield* emit({
            type: "session.exited",
            ...(yield* stamp),
            provider: options.provider,
            threadId: context.threadId,
            payload: context.disconnected
              ? { exitKind: "error", reason: "ACP process stopped." }
              : { exitKind: "graceful" },
          });
        }),
      )
      .pipe(
        Effect.uninterruptible,
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: options.provider,
              method: "session/stop",
              detail: "Could not stop ACP session cleanly.",
              cause,
            }),
        ),
      );

  const handlePermission = (
    context: SessionContext,
    request: EffectAcpSchema.RequestPermissionRequest,
  ) =>
    Effect.gen(function* () {
      if (context.stopped || request.sessionId !== context.nativeSessionId)
        return { outcome: { outcome: "cancelled" } } as const;
      const id = ApprovalRequestId.make(yield* crypto.randomUUIDv4);
      const decision = yield* Deferred.make<ProviderApprovalDecision>();
      context.approvals.set(id, { request, decision });
      const parsed = parsePermissionRequest(request);
      yield* emit(
        makeAcpRequestOpenedEvent({
          stamp: yield* stamp,
          provider: options.provider,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId: RuntimeRequestId.make(id),
          permissionRequest: parsed,
          detail: parsed.detail ?? parsed.toolCall?.title ?? "ACP agent requests permission.",
          args: request,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: request,
        }),
      );
      const answer = yield* Deferred.await(decision);
      yield* emit(
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: options.provider,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          requestId: RuntimeRequestId.make(id),
          permissionRequest: parsed,
          decision: answer,
        }),
      );
      context.approvals.delete(id);
      const optionId = answer === "cancel" ? undefined : selectedPermissionOption(request, answer);
      return optionId
        ? ({ outcome: { outcome: "selected", optionId } } as const)
        : ({ outcome: { outcome: "cancelled" } } as const);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() =>
          context.approvals.forEach((v, k) => v.request === request && context.approvals.delete(k)),
        ),
      ),
    );

  const handleEvent = (context: SessionContext, event: AcpSessionRuntime.AcpSessionRuntimeEvent) =>
    Effect.gen(function* () {
      if (event._tag === "EventStreamBarrier") {
        yield* Deferred.succeed(event.acknowledge, undefined);
        return;
      }
      if (context.stopped) return;
      if (event._tag === "ConnectionTerminated") {
        context.disconnected = true;
        yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
        return;
      }
      if (event._tag === "AssistantItemStarted" || event._tag === "AssistantItemCompleted")
        return yield* emit(
          makeAcpAssistantItemEvent({
            stamp: yield* stamp,
            provider: options.provider,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId: event.itemId,
            lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
          }),
        );
      if (event._tag === "ContentDelta" || event._tag === "ThoughtDelta")
        return yield* emit(
          makeAcpContentDeltaEvent({
            stamp: yield* stamp,
            provider: options.provider,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
            ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" } : {}),
            text: event.text,
            rawPayload: event.rawPayload,
          }),
        );
      if (event._tag === "PlanUpdated")
        return yield* emit(
          makeAcpPlanUpdatedEvent({
            stamp: yield* stamp,
            provider: options.provider,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: event.rawPayload,
          }),
        );
      if (event._tag === "ToolCallUpdated")
        return yield* emit(
          makeAcpToolCallEvent({
            stamp: yield* stamp,
            provider: options.provider,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            toolCall: event.toolCall,
            rawPayload: event.rawPayload,
          }),
        );
    });

  const startSession: Adapter["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (
          (input.provider && input.provider !== options.provider) ||
          (input.providerInstanceId && input.providerInstanceId !== options.instanceId) ||
          (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
        )
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "startSession",
            issue: "Provider instance does not match this adapter.",
          });
        if (!input.cwd?.trim())
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "startSession",
            issue: "A workspace directory is required.",
          });
        const savedId = resumeId(input.resumeCursor);
        if (input.resumeCursor !== undefined && !savedId)
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "startSession",
            issue: "The saved ACP session cursor is invalid.",
          });
        const cwd = path.resolve(input.cwd);
        const info = yield* fs.stat(cwd).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterValidationError({
                provider: options.provider,
                operation: "startSession",
                issue: "Workspace directory does not exist.",
                cause,
              }),
          ),
        );
        if (info.type !== "Directory")
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "startSession",
            issue: "Workspace path is not a directory.",
          });
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const scope = yield* Scope.make("sequential");
        let context: SessionContext | undefined;
        return yield* Effect.gen(function* () {
          const runtime = yield* options.makeRuntime({
            cwd,
            ...(savedId ? { resumeSessionId: savedId, resumeMethod: "load" as const } : {}),
            ...(options.mcpServers
              ? { mcpServers: yield* options.mcpServers(input.threadId) }
              : {}),
          });
          const terminals = yield* makeAcpClientTerminals({
            spawner,
            defaultCwd: cwd,
            ...(options.terminalEnvironment ? { environment: options.terminalEnvironment } : {}),
          });
          yield* runtime.handleUnknownExtRequest((method) =>
            Effect.fail(EffectAcpErrors.AcpRequestError.methodNotFound(method)),
          );
          yield* runtime.handleReadTextFile((request) => acpReadTextFile(fs, request));
          yield* runtime.handleWriteTextFile((request) => acpWriteTextFile(fs, request));
          yield* runtime.handleCreateTerminal(terminals.create);
          yield* runtime.handleTerminalOutput(terminals.output);
          yield* runtime.handleTerminalWaitForExit(terminals.waitForExit);
          yield* runtime.handleTerminalKill(terminals.kill);
          yield* runtime.handleTerminalRelease(terminals.release);
          yield* runtime.handleRequestPermission((request) =>
            context
              ? handlePermission(context, request).pipe(
                  Effect.mapError((cause) =>
                    EffectAcpErrors.AcpRequestError.internalError(
                      "Permission request failed.",
                      undefined,
                      { cause },
                    ),
                  ),
                )
              : Effect.succeed({ outcome: { outcome: "cancelled" } }),
          );
          const started = yield* runtime.start();
          if (input.modelSelection?.model && input.modelSelection.model !== "default") {
            yield* runtime.setModel(input.modelSelection.model);
          }
          for (const selection of input.modelSelection?.options ?? []) {
            yield* runtime.setConfigOption(selection.id, selection.value);
          }
          const modeId = requestedModeId(yield* runtime.getModeState, input.runtimeMode, undefined);
          if (modeId) yield* runtime.setMode(modeId);
          const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
          const session: ProviderSession = {
            provider: options.provider,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            resumeCursor: { schemaVersion: RESUME_VERSION, sessionId: started.sessionId },
            createdAt,
            updatedAt: createdAt,
          };
          context = {
            threadId: input.threadId,
            nativeSessionId: started.sessionId,
            runtime,
            scope,
            lock: yield* Semaphore.make(1),
            approvals: new Map(),
            terminals,
            session,
            activeTurnId: undefined,
            promptFiber: undefined,
            stopped: false,
            disconnected: false,
          };
          sessions.set(input.threadId, context);
          yield* Stream.runForEach(runtime.getEvents(), (event) =>
            handleEvent(context!, event),
          ).pipe(
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope),
          );
          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: options.provider,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: options.provider,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          return session;
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) =>
            isAcpError(cause)
              ? mapError(input.threadId, "session/start", cause)
              : isAdapterError(cause)
                ? cause
                : new ProviderAdapterRequestError({
                    provider: options.provider,
                    method: "session/start",
                    detail: "Could not start ACP session.",
                    cause,
                  }),
          ),
          Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
        );
      }),
    );

  const sendTurn: Adapter["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId)
        return yield* new ProviderAdapterValidationError({
          provider: options.provider,
          operation: "sendTurn",
          issue: "Selected model belongs to another provider instance.",
        });
      const prompt: Array<EffectAcpSchema.ContentBlock> = [];
      if (input.input?.trim()) prompt.push({ type: "text", text: input.input.trim() });
      for (const attachment of input.attachments ?? [])
        if (attachment.type === "image") {
          const file = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!file)
            return yield* new ProviderAdapterValidationError({
              provider: options.provider,
              operation: "sendTurn",
              issue: "Invalid attachment path.",
            });
          const bytes = yield* fs.readFile(file).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: options.provider,
                  method: "fs/read",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          if (bytes.length > MAX_CLIENT_FILE_BYTES)
            return yield* new ProviderAdapterValidationError({
              provider: options.provider,
              operation: "sendTurn",
              issue: "Attachment exceeds 8 MiB.",
            });
          prompt.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
      if (!prompt.length)
        return yield* new ProviderAdapterValidationError({
          provider: options.provider,
          operation: "sendTurn",
          issue: "Turn requires text or an image attachment.",
        });
      return yield* context.lock.withPermit(
        Effect.gen(function* () {
          if (
            input.modelSelection?.model &&
            input.modelSelection.model !== "default" &&
            input.modelSelection.model !== context.session.model
          ) {
            yield* context.runtime.setModel(input.modelSelection.model);
          }
          for (const selection of input.modelSelection?.options ?? []) {
            yield* context.runtime.setConfigOption(selection.id, selection.value);
          }
          const modeId = requestedModeId(
            yield* context.runtime.getModeState,
            context.session.runtimeMode,
            input.interactionMode,
          );
          if (modeId) yield* context.runtime.setMode(modeId);
          const turnId = TurnId.make(yield* crypto.randomUUIDv4);
          context.activeTurnId = turnId;
          yield* emit({
            type: "turn.started",
            ...(yield* stamp),
            provider: options.provider,
            threadId: input.threadId,
            turnId,
            payload: input.modelSelection?.model ? { model: input.modelSelection.model } : {},
          });
          return yield* Effect.gen(function* () {
            const fiber = yield* context.runtime
              .prompt({ prompt })
              .pipe(Effect.forkIn(context.scope));
            context.promptFiber = fiber;
            const result = yield* Fiber.join(fiber);
            yield* context.runtime.drainEvents;
            context.session = {
              ...context.session,
              status: "ready",
              activeTurnId: undefined,
              updatedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
            };
            yield* emit({
              type: "turn.completed",
              ...(yield* stamp),
              provider: options.provider,
              threadId: input.threadId,
              turnId,
              payload: {
                state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: result.stopReason,
              },
            });
            return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
          }).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                context.session = {
                  ...context.session,
                  status: "error",
                  activeTurnId: undefined,
                  lastError: "ACP prompt failed.",
                  updatedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
                };
                yield* emit({
                  type: "turn.completed",
                  ...(yield* stamp),
                  provider: options.provider,
                  threadId: input.threadId,
                  turnId,
                  payload: { state: "failed", errorMessage: "ACP prompt failed." },
                });
              }).pipe(Effect.ignore),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                context.activeTurnId = undefined;
                context.promptFiber = undefined;
              }),
            ),
          );
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isAcpError(cause)
          ? mapError(input.threadId, "session/prompt", cause)
          : isAdapterError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: options.provider,
                method: "session/prompt",
                detail: "ACP prompt failed.",
                cause,
              }),
      ),
    );

  const stopAll = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true }).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ensuring(PubSub.shutdown(events))));
  return {
    provider: options.provider,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn: (threadId) =>
      Effect.flatMap(requireSession(threadId), (context) =>
        Effect.andThen(cancelApprovals(context), context.runtime.cancel),
      ).pipe(
        Effect.mapError((cause) =>
          isAcpError(cause) ? mapError(threadId, "session/cancel", cause) : cause,
        ),
      ),
    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.approvals.get(requestId);
        if (!pending)
          return yield* new ProviderAdapterRequestError({
            provider: options.provider,
            method: "session/request_permission",
            detail: "Approval request is no longer pending.",
          });
        if (decision !== "cancel" && !selectedPermissionOption(pending.request, decision))
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "respondToRequest",
            issue: "ACP agent did not advertise that permission choice.",
          });
        yield* Deferred.succeed(pending.decision, decision);
      }),
    respondToUserInput: (threadId, _requestId, _answers: ProviderUserInputAnswers) =>
      Effect.andThen(
        requireSession(threadId),
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "respondToUserInput",
            issue: "Generic ACP structured user input is not supported.",
          }),
        ),
      ),
    stopSession: (threadId) =>
      withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext)),
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()].filter((x) => !x.stopped).map((x) => ({ ...x.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => !!sessions.get(threadId) && !sessions.get(threadId)!.stopped),
    readThread: (threadId) =>
      Effect.andThen(
        requireSession(threadId),
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "readThread",
            issue: "ACP does not provide a safe conversation snapshot API.",
          }),
        ),
      ),
    rollbackThread: (threadId) =>
      Effect.andThen(
        requireSession(threadId),
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "rollbackThread",
            issue: "ACP does not support conversation rewind.",
          }),
        ),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});

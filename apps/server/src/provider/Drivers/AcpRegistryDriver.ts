import {
  AcpRegistrySettings,
  officialAcpRegistryIconUrlForAgentId,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import {
  AcpRegistryCatalog,
  type AcpRegistryInspection,
  type ResolvedAcpRegistryAgent,
} from "../acp/AcpRegistrySupport.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGenericAcpAdapter, type GenericAcpRuntimeInput } from "../Layers/GenericAcpAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { providerModelsFromSettings } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const capabilities = createModelCapabilities({ optionDescriptors: [] });
const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export function acpRegistryRuntimeOptions(
  settings: AcpRegistrySettings,
  input: GenericAcpRuntimeInput,
  spawn: ResolvedAcpRegistryAgent["spawn"],
): AcpSessionRuntime.AcpSessionRuntimeOptions {
  return {
    spawn,
    cwd: input.cwd,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    ...(input.resumeMethod ? { resumeMethod: input.resumeMethod } : {}),
    clientInfo: { name: "t3-code", version: "0.0.0" },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    authenticateOnAuthRequired: true,
    ...(settings.authMethodId ? { authMethodId: settings.authMethodId } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
  };
}

const unsupportedTextGeneration = (): TextGeneration["Service"] => {
  const fail = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "ACP Registry instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  };
};

export function acpRegistrySnapshotReadiness(
  inspection: AcpRegistryInspection | { readonly status: "failed"; readonly message: string },
): Pick<ServerProvider, "installed" | "version" | "status" | "message"> {
  switch (inspection.status) {
    case "ready":
      return { installed: true, version: inspection.version, status: "ready" };
    case "unconfigured":
      return {
        installed: false,
        version: null,
        status: "warning",
        message: "Select an ACP Registry agent before starting a thread.",
      };
    case "not_found":
      return {
        installed: false,
        version: null,
        status: "error",
        message: `ACP Registry does not contain agent '${inspection.agentId}'.`,
      };
    case "unsupported":
      return {
        installed: false,
        version: inspection.version,
        status: "error",
        message: `ACP Registry agent '${inspection.agentId}' has no compatible distribution for this platform.`,
      };
    case "missing_runner":
      return {
        installed: false,
        version: inspection.version,
        status: "error",
        message: `ACP Registry agent '${inspection.agentId}' requires '${inspection.runner}' on this environment's PATH.`,
      };
    case "unprepared":
      return {
        installed: false,
        version: inspection.version,
        status: "warning",
        message: `ACP Registry agent '${inspection.agentId}' must be prepared before it can run.`,
      };
    case "failed":
      return { installed: false, version: null, status: "error", message: inspection.message };
  }
}

function isAuthenticationFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /auth(?:entication|orization)?(?: is)? required|not authenticated|sign[ -]?in required|-32000/iu.test(
    text,
  );
}

export function buildAcpRegistrySnapshot(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName?: string;
  readonly accentColor?: string;
  readonly continuationKey: string;
  readonly settings: AcpRegistrySettings;
  readonly checkedAt: string;
  readonly inspection:
    | AcpRegistryInspection
    | { readonly status: "failed"; readonly message: string };
  readonly probeError?: unknown;
}): ServerProvider {
  const readiness = acpRegistrySnapshotReadiness(input.inspection);
  const authRequired = input.probeError !== undefined && isAuthenticationFailure(input.probeError);
  const iconUrl = officialAcpRegistryIconUrlForAgentId(input.settings.agentId);
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    continuation: { groupKey: input.continuationKey },
    supportsTextGeneration: false,
    enabled: input.settings.enabled,
    installed: readiness.installed,
    version: readiness.version,
    status: input.settings.enabled
      ? input.probeError === undefined
        ? readiness.status
        : authRequired
          ? "warning"
          : "error"
      : "disabled",
    auth: authRequired ? { status: "unauthenticated" } : { status: "unknown" },
    checkedAt: input.checkedAt,
    ...(input.probeError !== undefined
      ? {
          message: authRequired
            ? "This ACP agent requires authentication. Start a thread to sign in."
            : `ACP initialize failed: ${input.probeError instanceof Error ? input.probeError.message : String(input.probeError)}`,
        }
      : readiness.message
        ? { message: readiness.message }
        : {}),
    models: providerModelsFromSettings(
      [{ slug: "default", name: "Default", isCustom: false, isDefault: true, capabilities }],
      input.settings.customModels,
      capabilities,
    ),
    slashCommands: [],
    skills: [],
  };
}

export type AcpRegistryDriverEnv =
  | AcpRegistryCatalog
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "ACP Registry", supportsMultipleInstances: true },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const catalog = yield* AcpRegistryCatalog;
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const settings = { ...config, enabled } satisfies AcpRegistrySettings;
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const snapshotIdentity = {
        instanceId,
        continuationKey: continuationIdentity.continuationKey,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
      };

      const makeRuntime = (input: GenericAcpRuntimeInput) =>
        catalog.resolve(settings, input.cwd, processEnvironment).pipe(
          Effect.mapError(
            (cause) => new EffectAcpErrors.AcpTransportError({ detail: cause.message, cause }),
          ),
          Effect.flatMap(({ spawn }) =>
            AcpSessionRuntime.make(acpRegistryRuntimeOptions(settings, input, spawn)),
          ),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

      const checkProvider = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        if (!settings.enabled)
          return buildAcpRegistrySnapshot({
            ...snapshotIdentity,
            settings,
            checkedAt,
            inspection: { status: "unconfigured" },
          });
        const inspected = yield* Effect.result(catalog.inspect(settings, processEnvironment));
        if (Result.isFailure(inspected))
          return buildAcpRegistrySnapshot({
            ...snapshotIdentity,
            settings,
            checkedAt,
            inspection: {
              status: "failed",
              message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
            },
          });
        if (inspected.success.status !== "ready")
          return buildAcpRegistrySnapshot({
            ...snapshotIdentity,
            settings,
            checkedAt,
            inspection: inspected.success,
          });
        const probe = yield* Effect.result(
          makeRuntime({ cwd: serverConfig.cwd }).pipe(
            Effect.flatMap((runtime) => runtime.initialize()),
            Effect.scoped,
            Effect.timeoutOrElse({
              duration: "8 seconds",
              orElse: () =>
                Effect.fail(
                  new EffectAcpErrors.AcpTransportError({
                    detail: "ACP initialize timed out after 8 seconds.",
                    cause: "timeout",
                  }),
                ),
            }),
          ),
        );
        return buildAcpRegistrySnapshot({
          ...snapshotIdentity,
          settings,
          checkedAt,
          inspection: inspected.success,
          ...(Result.isFailure(probe) ? { probeError: probe.failure } : {}),
        });
      });
      const snapshotSettings = makeProviderSnapshotSettingsSource(settings, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<AcpRegistrySettings>
      >({
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => checkProvider,
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build the ACP Registry provider snapshot.",
              cause,
            }),
        ),
      );
      const adapter = yield* makeGenericAcpAdapter({
        provider: DRIVER_KIND,
        instanceId,
        makeRuntime,
        terminalEnvironment: processEnvironment,
      });
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: unsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to create the ACP Registry provider instance.",
            cause,
          }),
        ),
      ),
    ),
};

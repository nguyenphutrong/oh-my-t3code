import type { AmpSettings, ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const VERSION_TIMEOUT_MS = 4_000;
const AMP_API_KEY_ENV = "AMP_API_KEY";

const presentation = {
  displayName: "Amp",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
} as const;

const reasoningEffort = buildSelectOptionDescriptor({
  id: "reasoningEffort",
  label: "Reasoning effort",
  description: "Controls how much reasoning effort Amp uses for this thread.",
  options: [
    { value: "none", label: "None" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra high" },
    { value: "max", label: "Maximum" },
  ],
});

const capabilities: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [reasoningEffort],
});

export const AMP_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "low", name: "Low", isCustom: false, capabilities },
  { slug: "medium", name: "Medium", isCustom: false, isDefault: true, capabilities },
  { slug: "high", name: "High", isCustom: false, capabilities },
  { slug: "ultra", name: "Ultra", isCustom: false, capabilities },
];

export function makeInitialAmpProvider(settings: AmpSettings): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation,
      enabled: settings.enabled,
      checkedAt,
      models: AMP_MODELS,
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Amp CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Amp is disabled in T3 Code settings.",
          },
    });
  });
}

const runVersion = (settings: AmpSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "amp";
    const spawn = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, {
        env: environment,
        shell: spawn.shell,
      }),
    );
  });

export const checkAmpProviderStatus = Effect.fn("checkAmpProviderStatus")(function* (
  settings: AmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return yield* makeInitialAmpProvider(settings);

  const versionResult = yield* runVersion(settings, environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation,
      enabled: true,
      checkedAt,
      models: AMP_MODELS,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Amp CLI (`amp`) is not installed or not on PATH."
          : "Failed to execute the Amp CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success))
    return buildServerProvider({
      presentation,
      enabled: true,
      checkedAt,
      models: AMP_MODELS,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Amp CLI is installed but timed out while running `amp --version`.",
      },
    });

  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0)
    return buildServerProvider({
      presentation,
      enabled: true,
      checkedAt,
      models: AMP_MODELS,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Amp CLI is installed but failed to run.",
      },
    });

  return buildServerProvider({
    presentation,
    enabled: true,
    checkedAt,
    models: AMP_MODELS,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: environment[AMP_API_KEY_ENV]?.trim()
        ? { status: "authenticated", type: "api_key", label: "Amp API key" }
        : { status: "unknown" },
      ...(environment[AMP_API_KEY_ENV]?.trim()
        ? {}
        : {
            message:
              "Amp CLI is available. Authentication is managed by Amp; T3 Code does not inspect its credentials.",
          }),
    },
  });
});

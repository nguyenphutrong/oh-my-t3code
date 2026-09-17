import { AmpSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeAmpTextGeneration } from "../../textGeneration/AmpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAmpAdapter } from "../Layers/AmpAdapter.ts";
import { checkAmpProviderStatus, makeInitialAmpProvider } from "../Layers/AmpProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("amp");
const decodeSettings = Schema.decodeSync(AmpSettings);
const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@ampcode/cli",
});

export type AmpDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const AmpDriver: ProviderDriver<AmpSettings, AmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Amp", supportsMultipleInstances: true },
  configSchema: AmpSettings,
  defaultConfig: (): AmpSettings => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const settings = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
        ...(config.settingsFile ? { settingsFile: expandHomePath(config.settingsFile) } : {}),
      } satisfies AmpSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const adapter = yield* makeAmpAdapter(settings, {
        instanceId,
        attachmentsDir: serverConfig.attachmentsDir,
        environment: processEnvironment,
      });
      const textGeneration = yield* makeAmpTextGeneration(settings, processEnvironment);
      const checkProvider = checkAmpProviderStatus(settings, processEnvironment).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(settings, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<AmpSettings>>({
        resolveMaintenance: () => Effect.succeed(maintenance),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: ({ provider }) =>
          makeInitialAmpProvider(provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build the Amp provider snapshot.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to create the Amp provider instance.",
            cause,
          }),
        ),
      ),
    ),
};

import * as NodeOS from "node:os";

import { migrateLegacyT3Home } from "@t3tools/shared/legacyHomeMigration";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/unstable/cli";

import { resolveBaseDir } from "../os-jank.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { baseDirFlag } from "./config.ts";

const ImportT3Reason = Schema.Literals([
  "same-home",
  "source-missing",
  "destination-running",
  "replace-failed",
]);

export class ImportT3Error extends Schema.TaggedError<ImportT3Error>()("ImportT3Error", {
  reason: ImportT3Reason,
  path: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "same-home":
        return "The T3 Code source and Oh My T3Code destination must be different homes.";
      case "source-missing":
        return `No T3 Code data was found at ${this.path}.`;
      case "destination-running":
        return "Stop Oh My T3Code before importing T3 Code data again.";
      case "replace-failed":
        return `Could not replace Oh My T3Code data. The previous data remains at ${this.path}.`;
    }
  }
}

const assertDestinationStopped = Effect.fn(function* (destinationStateDir: string) {
  const path = yield* Path.Path;
  const runtimeState = yield* readPersistedServerRuntimeState(
    path.join(destinationStateDir, "server-runtime.json"),
  );
  if (Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* new ImportT3Error({
      reason: "destination-running",
      path: destinationStateDir,
    });
  }
});

export const importT3Home = Effect.fn("importT3Home")(function* (input: {
  readonly sourceBaseDir: string;
  readonly destinationBaseDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceBaseDir = path.resolve(input.sourceBaseDir);
  const destinationBaseDir = path.resolve(input.destinationBaseDir);
  const destinationStateDir = path.join(destinationBaseDir, "userdata");

  if (sourceBaseDir === destinationBaseDir) {
    return yield* new ImportT3Error({ reason: "same-home", path: sourceBaseDir });
  }
  yield* assertDestinationStopped(destinationStateDir);

  if (!(yield* fileSystem.exists(destinationStateDir))) {
    const migration = yield* migrateLegacyT3Home({ sourceBaseDir, destinationBaseDir });
    if (migration.status !== "migrated") {
      return yield* new ImportT3Error({
        reason: "source-missing",
        path: path.join(sourceBaseDir, "userdata"),
      });
    }
    return { entries: migration.entries, backupStateDir: null } as const;
  }

  const stagingBaseDir = yield* fileSystem.makeTempDirectory({
    directory: destinationBaseDir,
    prefix: ".import-t3-",
  });
  return yield* Effect.gen(function* () {
    const migration = yield* migrateLegacyT3Home({
      sourceBaseDir,
      destinationBaseDir: stagingBaseDir,
    });
    if (migration.status !== "migrated") {
      return yield* new ImportT3Error({
        reason: "source-missing",
        path: path.join(sourceBaseDir, "userdata"),
      });
    }

    yield* assertDestinationStopped(destinationStateDir);
    const backupStateDir = `${destinationStateDir}.backup-${yield* Clock.currentTimeMillis}`;
    yield* fileSystem.rename(destinationStateDir, backupStateDir).pipe(
      Effect.mapError(
        (cause) =>
          new ImportT3Error({
            reason: "replace-failed",
            path: destinationStateDir,
            cause,
          }),
      ),
    );
    yield* fileSystem.rename(path.join(stagingBaseDir, "userdata"), destinationStateDir).pipe(
      Effect.mapError(
        (cause) => new ImportT3Error({ reason: "replace-failed", path: backupStateDir, cause }),
      ),
      Effect.onError(() =>
        fileSystem.rename(backupStateDir, destinationStateDir).pipe(Effect.ignore),
      ),
    );
    return { entries: migration.entries, backupStateDir } as const;
  }).pipe(
    Effect.ensuring(
      fileSystem.remove(stagingBaseDir, { recursive: true, force: true }).pipe(Effect.ignore),
    ),
  );
});

export const importT3Command = Command.make("import-t3", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Import T3 Code data again, keeping the current data as a backup."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const envHome = yield* Config.string("T3CODE_HOME").pipe(Config.option);
      const destinationBaseDir = yield* resolveBaseDir(
        Option.getOrUndefined(flags.baseDir) ?? Option.getOrUndefined(envHome),
      );
      const result = yield* importT3Home({
        sourceBaseDir: path.join(NodeOS.homedir(), ".t3"),
        destinationBaseDir,
      });
      yield* Console.log(
        result.backupStateDir === null
          ? `Imported T3 Code data into ${destinationBaseDir}.\n`
          : `Imported T3 Code data into ${destinationBaseDir}. Previous data: ${result.backupStateDir}.\n`,
      );
    }),
  ),
);

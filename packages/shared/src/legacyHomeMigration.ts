import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "./nodeSqliteClient.ts";

const DATABASE_FILE = "state.sqlite";
const SKIPPED_STATE_ENTRIES = new Set([
  "logs",
  "server-runtime.json",
  DATABASE_FILE,
  `${DATABASE_FILE}-shm`,
  `${DATABASE_FILE}-wal`,
]);

const LegacyHomeMigrationOperation = Schema.Literals([
  "inspect-source",
  "prepare-destination",
  "copy-state",
  "snapshot-database",
  "activate-state",
]);
type LegacyHomeMigrationOperation = typeof LegacyHomeMigrationOperation.Type;

export class LegacyHomeMigrationError extends Schema.TaggedError<LegacyHomeMigrationError>()(
  "LegacyHomeMigrationError",
  {
    operation: LegacyHomeMigrationOperation,
    sourceStateDir: Schema.String,
    destinationStateDir: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to import existing T3 Code data during ${this.operation}. The original data at "${this.sourceStateDir}" was not changed.`;
  }
}

export type LegacyHomeMigrationResult =
  | { readonly status: "migrated"; readonly entries: ReadonlyArray<string> }
  | { readonly status: "source-missing" }
  | { readonly status: "destination-initialized" };

const wrapMigrationError =
  (operation: LegacyHomeMigrationOperation, sourceStateDir: string, destinationStateDir: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new LegacyHomeMigrationError({
            operation,
            sourceStateDir,
            destinationStateDir,
            cause,
          }),
      ),
    );

/**
 * Imports a previous T3 Code home once, before the fork initializes its own
 * userdata directory. SQLite is snapshotted instead of copying WAL files, so
 * an idle or running legacy server cannot leave the fork with a torn database.
 */
export const migrateLegacyT3Home = Effect.fn("migrateLegacyT3Home")(function* (input: {
  readonly sourceBaseDir: string;
  readonly destinationBaseDir: string;
}): Effect.fn.Return<
  LegacyHomeMigrationResult,
  LegacyHomeMigrationError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceStateDir = path.join(input.sourceBaseDir, "userdata");
  const destinationStateDir = path.join(input.destinationBaseDir, "userdata");
  const wrap = (operation: LegacyHomeMigrationOperation) =>
    wrapMigrationError(operation, sourceStateDir, destinationStateDir);

  if (yield* fileSystem.exists(destinationStateDir).pipe(wrap("prepare-destination"))) {
    return { status: "destination-initialized" } as const;
  }
  if (!(yield* fileSystem.exists(sourceStateDir).pipe(wrap("inspect-source")))) {
    return { status: "source-missing" } as const;
  }

  const sourceEntries = yield* fileSystem
    .readDirectory(sourceStateDir)
    .pipe(wrap("inspect-source"));
  const copyEntries = sourceEntries.filter((entry) => !SKIPPED_STATE_ENTRIES.has(entry));
  const sourceDatabasePath = path.join(sourceStateDir, DATABASE_FILE);
  const hasDatabase = yield* fileSystem.exists(sourceDatabasePath).pipe(wrap("inspect-source"));
  if (!hasDatabase && copyEntries.length === 0) {
    return { status: "source-missing" } as const;
  }

  yield* fileSystem
    .makeDirectory(input.destinationBaseDir, { recursive: true })
    .pipe(wrap("prepare-destination"));
  const stagingStateDir = yield* fileSystem
    .makeTempDirectory({
      directory: input.destinationBaseDir,
      prefix: ".legacy-t3-userdata-",
    })
    .pipe(wrap("prepare-destination"));

  return yield* Effect.gen(function* () {
    for (const entry of copyEntries) {
      yield* fileSystem
        .copy(path.join(sourceStateDir, entry), path.join(stagingStateDir, entry), {
          preserveTimestamps: true,
        })
        .pipe(wrap("copy-state"));
    }

    if (hasDatabase) {
      const destinationDatabasePath = path.join(stagingStateDir, DATABASE_FILE);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`VACUUM INTO ${destinationDatabasePath}`;
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: sourceDatabasePath, readonly: true })),
        wrap("snapshot-database"),
      );
      yield* fileSystem.chmod(destinationDatabasePath, 0o600).pipe(wrap("snapshot-database"));
    }

    // Another process may have initialized the destination while the snapshot
    // was being built. Keep that state and discard this import rather than
    // merging two independently changing homes.
    if (yield* fileSystem.exists(destinationStateDir).pipe(wrap("activate-state"))) {
      return { status: "destination-initialized" } as const;
    }
    yield* fileSystem.rename(stagingStateDir, destinationStateDir).pipe(wrap("activate-state"));
    return {
      status: "migrated",
      entries: [...copyEntries, ...(hasDatabase ? [DATABASE_FILE] : [])].sort(),
    } as const;
  }).pipe(
    Effect.ensuring(
      fileSystem.remove(stagingStateDir, { recursive: true, force: true }).pipe(Effect.ignore),
    ),
  );
});

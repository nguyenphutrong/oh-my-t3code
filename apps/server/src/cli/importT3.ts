import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import { migrateLegacyT3Home } from "@t3tools/shared/legacyHomeMigration";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { Command } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { baseDirFlag } from "./config.ts";

const CLEANUP_PROJECTOR = "projection.attachment-cleanup";
const SETTINGS_MAPS = [
  "providerInstances",
  "usageLimitSources",
  "projectSettingsOverrides",
  "projectAgentBrowserAccessOverrides",
  "projectAutoPullOverrides",
  "projectScriptOverrides",
] as const;
const PROJECT_SETTINGS_MAPS = new Set<(typeof SETTINGS_MAPS)[number]>([
  "projectSettingsOverrides",
  "projectAgentBrowserAccessOverrides",
  "projectAutoPullOverrides",
  "projectScriptOverrides",
]);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export class ImportT3Error extends Schema.TaggedError<ImportT3Error>()("ImportT3Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

interface ImportCounts {
  readonly projects: number;
  readonly threads: number;
  readonly skippedProjects: number;
  readonly skippedThreads: number;
  readonly projectIds: ReadonlySet<string>;
}

interface ColumnInfo {
  readonly name: string;
}

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

const scalar = <T>(
  database: NodeSqlite.DatabaseSync,
  sql: string,
  ...params: NodeSqlite.SQLInputValue[]
): T => (database.prepare(sql).get(...params) as Record<string, T> | undefined)?.value as T;

const columns = (
  database: NodeSqlite.DatabaseSync,
  schema: string,
  table: string,
): readonly ColumnInfo[] =>
  database
    .prepare(`PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(table)})`)
    .all() as unknown as readonly ColumnInfo[];

const assertProjectorsCaughtUp = (database: NodeSqlite.DatabaseSync, schema: string) => {
  const tip = scalar<number>(
    database,
    `SELECT COALESCE(MAX(sequence), 0) AS value FROM ${quoteIdentifier(schema)}.orchestration_events`,
  );
  if (tip === 0) return;

  const stale = scalar<number>(
    database,
    `SELECT COUNT(*) AS value
       FROM ${quoteIdentifier(schema)}.projection_state
      WHERE projector <> ? AND last_applied_sequence <> ?`,
    CLEANUP_PROJECTOR,
    tip,
  );
  const projectors = scalar<number>(
    database,
    `SELECT COUNT(*) AS value
       FROM ${quoteIdentifier(schema)}.projection_state
      WHERE projector <> ?`,
    CLEANUP_PROJECTOR,
  );
  if (projectors === 0 || stale > 0) {
    throw new Error(`${schema} projections are not caught up with the event log`);
  }
};

const copySelectedRows = (
  database: NodeSqlite.DatabaseSync,
  table: string,
  selector: "project_id" | "thread_id",
  excludedColumns: ReadonlySet<string> = new Set(),
) => {
  const sourceColumns = columns(database, "source", table);
  const destinationColumns = columns(database, "main", table);
  if (destinationColumns.length === 0) return;

  const destinationNames = new Set(destinationColumns.map(({ name }) => name));
  const selectedColumns = sourceColumns.filter(
    ({ name }) => destinationNames.has(name) && !excludedColumns.has(name),
  );
  const names = selectedColumns.map(({ name }) => quoteIdentifier(name)).join(", ");
  database.exec(
    `INSERT INTO main.${quoteIdentifier(table)} (${names})
     SELECT ${names} FROM source.${quoteIdentifier(table)}
      WHERE ${quoteIdentifier(selector)} IN (SELECT id FROM imported_${selector === "project_id" ? "projects" : "threads"})`,
  );
};

/** Add complete source-only project/thread graphs. Existing destination aggregates always win. */
export const mergeT3StateDatabases = (input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
}): ImportCounts => {
  const database = new NodeSqlite.DatabaseSync(input.destinationPath);
  database.exec("PRAGMA busy_timeout = 5000");
  database.prepare("ATTACH DATABASE ? AS source").run(input.sourcePath);

  try {
    assertProjectorsCaughtUp(database, "main");
    assertProjectorsCaughtUp(database, "source");
    database.exec("BEGIN IMMEDIATE");
    database.exec(`
      CREATE TEMP TABLE imported_projects(id TEXT PRIMARY KEY);
      CREATE TEMP TABLE imported_threads(id TEXT PRIMARY KEY);
      INSERT INTO imported_projects
      SELECT source.project_id
        FROM source.projection_projects AS source
       WHERE NOT EXISTS (
               SELECT 1 FROM main.projection_projects AS destination
                WHERE destination.project_id = source.project_id
             )
         AND NOT EXISTS (
               SELECT 1 FROM main.projection_projects AS destination
                WHERE destination.deleted_at IS NULL
                  AND source.deleted_at IS NULL
                  AND destination.workspace_root = source.workspace_root
             );
      INSERT INTO imported_threads
      SELECT source.thread_id
        FROM source.projection_threads AS source
       WHERE NOT EXISTS (
               SELECT 1 FROM main.projection_threads AS destination
                WHERE destination.thread_id = source.thread_id
             )
         AND (
               EXISTS (
                 SELECT 1
                   FROM main.projection_projects AS destination_project
                   JOIN source.projection_projects AS source_project
                     ON source_project.project_id = source.project_id
                  WHERE destination_project.project_id = source.project_id
                    AND destination_project.workspace_root = source_project.workspace_root
               )
               OR EXISTS (SELECT 1 FROM imported_projects WHERE id = source.project_id)
             );
    `);

    const projects = scalar<number>(database, "SELECT COUNT(*) AS value FROM imported_projects");
    const threads = scalar<number>(database, "SELECT COUNT(*) AS value FROM imported_threads");
    const sourceProjects = scalar<number>(
      database,
      "SELECT COUNT(*) AS value FROM source.projection_projects",
    );
    const sourceThreads = scalar<number>(
      database,
      "SELECT COUNT(*) AS value FROM source.projection_threads",
    );

    copySelectedRows(database, "projection_projects", "project_id");
    copySelectedRows(database, "projection_threads", "thread_id");

    const sourceTables = database
      .prepare(
        "SELECT name FROM source.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as unknown as readonly { readonly name: string }[];
    for (const { name } of sourceTables) {
      if (
        name === "projection_projects" ||
        name === "projection_threads" ||
        name === "orchestration_events" ||
        name === "projection_state"
      ) {
        continue;
      }
      const sourceColumns = columns(database, "source", name);
      if (sourceColumns.some(({ name: column }) => column === "thread_id")) {
        copySelectedRows(
          database,
          name,
          "thread_id",
          name === "projection_turns" ? new Set(["row_id"]) : undefined,
        );
      } else if (sourceColumns.some(({ name: column }) => column === "project_id")) {
        copySelectedRows(database, name, "project_id");
      }
    }

    const eventColumns = columns(database, "source", "orchestration_events")
      .map(({ name }) => name)
      .filter((name) => name !== "sequence");
    const quotedEventColumns = eventColumns.map(quoteIdentifier).join(", ");
    database.exec(
      `INSERT INTO main.orchestration_events (${quotedEventColumns})
       SELECT ${quotedEventColumns} FROM source.orchestration_events
        WHERE (aggregate_kind = 'project' AND stream_id IN (SELECT id FROM imported_projects))
           OR (aggregate_kind = 'thread' AND stream_id IN (SELECT id FROM imported_threads))
       ORDER BY sequence`,
    );

    database.exec(`
      UPDATE main.projection_thread_sessions
         SET status = 'stopped', active_turn_id = NULL
       WHERE thread_id IN (SELECT id FROM imported_threads);
      UPDATE main.provider_session_runtime
         SET status = 'stopped'
       WHERE thread_id IN (SELECT id FROM imported_threads);
      UPDATE main.projection_turns
         SET state = 'interrupted', completed_at = COALESCE(completed_at, datetime('now'))
       WHERE thread_id IN (SELECT id FROM imported_threads)
         AND state = 'running';
    `);

    const tip = scalar<number>(
      database,
      "SELECT COALESCE(MAX(sequence), 0) AS value FROM main.orchestration_events",
    );
    database
      .prepare(
        `UPDATE main.projection_state
            SET last_applied_sequence = ?, updated_at = datetime('now')
          WHERE projector <> ?`,
      )
      .run(tip, CLEANUP_PROJECTOR);
    database
      .prepare(
        `INSERT OR IGNORE INTO main.projection_state(projector, last_applied_sequence, updated_at)
         SELECT projector, ?, datetime('now') FROM source.projection_state WHERE projector <> ?`,
      )
      .run(tip, CLEANUP_PROJECTOR);
    const projectIds = new Set(
      (
        database
          .prepare("SELECT project_id FROM main.projection_projects")
          .all() as unknown as readonly {
          readonly project_id: string;
        }[]
      ).map(({ project_id }) => project_id),
    );
    database.exec("COMMIT");

    return {
      projects,
      threads,
      skippedProjects: sourceProjects - projects,
      skippedThreads: sourceThreads - threads,
      projectIds,
    };
  } catch (cause) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // No transaction was started.
    }
    throw cause;
  } finally {
    try {
      database.exec("DETACH DATABASE source");
    } finally {
      database.close();
    }
  }
};

const readJsonObject = Effect.fn(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath))) return {} as Record<string, unknown>;
  const parsed = decodeJson(yield* fs.readFileString(filePath));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
});

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const providerSecretName = (instanceId: string, name: string) =>
  `provider-env-${Buffer.from(instanceId, "utf8").toString("base64url")}-${Buffer.from(name, "utf8").toString("base64url")}`;

const usageSecretName = (sourceId: string) =>
  `usage-limit-source-${Buffer.from(sourceId, "utf8").toString("base64url")}`;

export const mergeT3Settings = Effect.fn(function* (
  sourcePath: string,
  destinationPath: string,
  projectIds: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* readJsonObject(sourcePath);
  const destination = yield* readJsonObject(destinationPath);
  let changed = false;
  let count = 0;
  const merged = { ...destination };
  const importedProviders = new Set<string>();
  const importedUsageSources = new Set<string>();
  for (const key of SETTINGS_MAPS) {
    const sourceEntries = Object.fromEntries(
      Object.entries(asRecord(source[key])).filter(
        ([id]) => !PROJECT_SETTINGS_MAPS.has(key) || projectIds.has(id),
      ),
    );
    const destinationEntries = asRecord(destination[key]);
    const next = { ...sourceEntries, ...destinationEntries };
    const imported = Object.keys(sourceEntries).filter((id) => !(id in destinationEntries));
    if (imported.length > 0) {
      changed = true;
      count += imported.length;
      if (key === "providerInstances") imported.forEach((id) => importedProviders.add(id));
      if (key === "usageLimitSources") imported.forEach((id) => importedUsageSources.add(id));
    }
    if (Object.keys(next).length > 0) merged[key] = next;
  }
  if (changed) {
    const temporaryPath = `${destinationPath}.import-t3.tmp`;
    yield* fs.writeFileString(temporaryPath, `${encodeJson(merged)}\n`);
    yield* fs.rename(temporaryPath, destinationPath);
  }

  const secretNames = new Set<string>();
  const providers = asRecord(source.providerInstances);
  for (const instanceId of importedProviders) {
    const environment = asRecord(providers[instanceId]).environment;
    if (!Array.isArray(environment)) continue;
    for (const variable of environment) {
      const record = asRecord(variable);
      if (record.sensitive === true && typeof record.name === "string") {
        secretNames.add(providerSecretName(instanceId, record.name));
      }
    }
  }
  importedUsageSources.forEach((id) => secretNames.add(usageSecretName(id)));
  return { count, secretNames } as const;
});

const copyMissingFiles: (
  source: string,
  destination: string,
) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =
  Effect.fn(function* (source: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(source))) return;
    const info = yield* fs.stat(source);
    if (info.type === "Directory") {
      yield* fs.makeDirectory(destination, { recursive: true });
      for (const entry of yield* fs.readDirectory(source)) {
        yield* copyMissingFiles(path.join(source, entry), path.join(destination, entry));
      }
    } else if (!(yield* fs.exists(destination))) {
      yield* fs.copyFile(source, destination);
    }
  });

const isServerRunning = Effect.fn(function* (runtimeStatePath: string) {
  const state = yield* readPersistedServerRuntimeState(runtimeStatePath);
  return Option.isSome(state) && isProcessAlive(state.value.pid);
});

export const importT3Command = Command.make("import-t3", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Add projects, threads, and provider settings from T3 Code without overwriting existing data",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const envHome = yield* Config.string("T3CODE_HOME").pipe(Config.option);
      const destinationBaseDir = yield* resolveBaseDir(
        Option.getOrUndefined(flags.baseDir) ?? Option.getOrUndefined(envHome),
      );
      const config = yield* ServerConfig.deriveServerPaths(destinationBaseDir, undefined, {
        baseDirIsExplicit: Option.isSome(flags.baseDir) || Option.isSome(envHome),
      });
      const sourceBaseDir = path.join(NodeOS.homedir(), ".t3");
      const sourceUserdata = path.join(sourceBaseDir, "userdata");
      const sourceDatabase = path.join(sourceUserdata, "state.sqlite");
      if (path.resolve(sourceBaseDir) === path.resolve(destinationBaseDir)) {
        return yield* new ImportT3Error({
          message: "The T3 Code source and Oh My T3Code destination must use different homes.",
        });
      }
      if (!(yield* fs.exists(sourceDatabase))) {
        return yield* new ImportT3Error({
          message: `No T3 Code data found at ${sourceUserdata}.`,
        });
      }
      if (yield* isServerRunning(config.serverRuntimeStatePath)) {
        return yield* new ImportT3Error({
          message:
            "Close Oh My T3Code before importing, then restart it after the command finishes.",
        });
      }
      const sourceRuntimeState = path.join(sourceUserdata, "server-runtime.json");
      if (yield* isServerRunning(sourceRuntimeState)) {
        return yield* new ImportT3Error({
          message: "Close T3 Code before importing so its database and files stay consistent.",
        });
      }
      if (!(yield* fs.exists(config.dbPath))) {
        return yield* new ImportT3Error({
          message: "Open Oh My T3Code once before running the import command.",
        });
      }

      const stagingRoot = yield* fs.makeTempDirectoryScoped({ prefix: "oh-my-t3code-import-" });
      const stagedUserdata = path.join(stagingRoot, "userdata");
      const staged = yield* migrateLegacyT3Home({
        sourceBaseDir,
        destinationBaseDir: stagingRoot,
      });
      if (staged.status !== "migrated") {
        return yield* new ImportT3Error({ message: `No T3 Code data found at ${sourceUserdata}.` });
      }

      const counts = yield* Effect.try({
        try: () =>
          mergeT3StateDatabases({
            sourcePath: path.join(stagedUserdata, "state.sqlite"),
            destinationPath: config.dbPath,
          }),
        catch: (cause) =>
          new ImportT3Error({ message: "Failed to merge T3 Code database.", cause }),
      });
      const settings = yield* mergeT3Settings(
        path.join(stagedUserdata, "settings.json"),
        config.settingsPath,
        counts.projectIds,
      ).pipe(
        Effect.mapError(
          (cause) => new ImportT3Error({ message: "Failed to merge T3 Code settings.", cause }),
        ),
      );
      for (const directory of ["attachments", "browser-artifacts", "themes"] as const) {
        yield* copyMissingFiles(
          path.join(stagedUserdata, directory),
          path.join(config.stateDir, directory),
        ).pipe(
          Effect.mapError(
            (cause) => new ImportT3Error({ message: `Failed to import ${directory}.`, cause }),
          ),
        );
      }
      for (const secretName of settings.secretNames) {
        yield* copyMissingFiles(
          path.join(stagedUserdata, "secrets", `${secretName}.bin`),
          path.join(config.secretsDir, `${secretName}.bin`),
        ).pipe(
          Effect.mapError(
            (cause) => new ImportT3Error({ message: "Failed to import provider secrets.", cause }),
          ),
        );
      }

      yield* Console.log(
        `Imported ${counts.projects} projects, ${counts.threads} threads, and ${settings.count} settings entries. ` +
          `Skipped ${counts.skippedProjects} existing/conflicting projects and ${counts.skippedThreads} existing threads. ` +
          "Restart Oh My T3Code to load them.\n",
      );
    }).pipe(Effect.scoped),
  ),
);

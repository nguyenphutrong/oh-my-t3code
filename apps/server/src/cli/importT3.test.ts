import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { mergeT3Settings, mergeT3StateDatabases } from "./importT3.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const createDatabase = (path: string) => {
  const database = new NodeSqlite.DatabaseSync(path);
  database.exec(`
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      UNIQUE (aggregate_kind, stream_id, stream_version)
    );
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      active_turn_id TEXT
    );
    CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      state TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (thread_id, turn_id)
    );
    CREATE TABLE provider_session_runtime (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE projection_state (
      projector TEXT PRIMARY KEY,
      last_applied_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return database;
};

const addEvent = (
  database: NodeSqlite.DatabaseSync,
  sequence: number,
  kind: "project" | "thread",
  id: string,
) => {
  database
    .prepare(
      `INSERT INTO orchestration_events
       (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
       VALUES (?, ?, ?, ?, 1, 'created', '2026-09-17', NULL, NULL, NULL, 'user', '{}', '{}')`,
    )
    .run(sequence, `event-${kind}-${id}`, kind, id);
};

it.layer(NodeServices.layer)("T3 Code additive import", (it) => {
  it.effect("adds only source-only project/thread graphs and is repeatable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-merge-" });
        const sourcePath = path.join(root, "source.sqlite");
        const destinationPath = path.join(root, "destination.sqlite");
        const source = createDatabase(sourcePath);
        const destination = createDatabase(destinationPath);
        destination.exec(`
      INSERT INTO projection_projects VALUES ('project-existing', 'Destination', '/workspace/a', 'now', 'now', NULL);
      INSERT INTO projection_projects VALUES ('project-incompatible', 'Destination incompatible', '/workspace/destination', 'now', 'now', NULL);
      INSERT INTO projection_threads VALUES ('thread-existing', 'project-existing', 'Destination thread', 'now', 'now');
      INSERT INTO projection_thread_messages VALUES ('message-existing', 'thread-existing', 'keep me');
      INSERT INTO projection_turns(row_id, thread_id, turn_id, state, completed_at)
        VALUES (50, 'thread-existing', 'turn-existing', 'completed', 'now');
    `);
        addEvent(destination, 10, "project", "project-existing");
        addEvent(destination, 11, "thread", "thread-existing");
        destination
          .prepare("INSERT INTO projection_state VALUES ('projection.threads', 11, 'now')")
          .run();

        source.exec(`
      INSERT INTO projection_projects VALUES
        ('project-existing', 'Source overwrite', '/workspace/a', 'now', 'now', NULL),
        ('project-incompatible', 'Source incompatible', '/workspace/source', 'now', 'now', NULL),
        ('project-new', 'Imported', '/workspace/b', 'now', 'now', NULL),
        ('project-root-conflict', 'Conflict', '/workspace/a', 'now', 'now', NULL);
      INSERT INTO projection_threads VALUES
        ('thread-existing', 'project-existing', 'Source overwrite', 'now', 'now'),
        ('thread-incompatible', 'project-incompatible', 'Skipped incompatible', 'now', 'now'),
        ('thread-under-existing-project', 'project-existing', 'Imported sibling', 'now', 'now'),
        ('thread-new', 'project-new', 'Imported thread', 'now', 'now'),
        ('thread-root-conflict', 'project-root-conflict', 'Skipped thread', 'now', 'now');
      INSERT INTO projection_thread_messages VALUES
        ('message-source-existing', 'thread-existing', 'do not import'),
        ('message-new', 'thread-new', 'import me');
      INSERT INTO projection_thread_sessions VALUES ('thread-new', 'running', 'turn-new');
      INSERT INTO projection_turns(row_id, thread_id, turn_id, state, completed_at)
        VALUES (90, 'thread-new', 'turn-new', 'running', NULL);
      INSERT INTO provider_session_runtime VALUES ('thread-new', 'running');
    `);
        addEvent(source, 100, "project", "project-existing");
        addEvent(source, 101, "thread", "thread-existing");
        addEvent(source, 102, "thread", "thread-under-existing-project");
        addEvent(source, 103, "project", "project-new");
        addEvent(source, 104, "thread", "thread-new");
        addEvent(source, 105, "project", "project-root-conflict");
        addEvent(source, 106, "thread", "thread-root-conflict");
        addEvent(source, 107, "project", "project-incompatible");
        addEvent(source, 108, "thread", "thread-incompatible");
        source
          .prepare("INSERT INTO projection_state VALUES ('projection.threads', 108, 'now')")
          .run();

        assert.deepEqual(mergeT3StateDatabases({ sourcePath, destinationPath }), {
          projects: 1,
          threads: 2,
          skippedProjects: 3,
          skippedThreads: 3,
          projectIds: new Set(["project-existing", "project-incompatible", "project-new"]),
        });

        const result = new NodeSqlite.DatabaseSync(destinationPath);
        assert.equal(
          (
            result
              .prepare(
                "SELECT title FROM projection_projects WHERE project_id = 'project-existing'",
              )
              .get() as { title: string }
          ).title,
          "Destination",
        );
        assert.deepEqual(
          result.prepare("SELECT thread_id FROM projection_threads ORDER BY thread_id").all(),
          [
            { thread_id: "thread-existing" },
            { thread_id: "thread-new" },
            { thread_id: "thread-under-existing-project" },
          ],
        );
        assert.deepEqual(
          result.prepare("SELECT text FROM projection_thread_messages ORDER BY text").all(),
          [{ text: "import me" }, { text: "keep me" }],
        );
        assert.deepEqual(
          result
            .prepare("SELECT row_id, state FROM projection_turns WHERE thread_id = 'thread-new'")
            .get(),
          { row_id: 51, state: "interrupted" },
        );
        assert.equal(
          (
            result
              .prepare("SELECT status FROM provider_session_runtime WHERE thread_id = 'thread-new'")
              .get() as { status: string }
          ).status,
          "stopped",
        );
        assert.deepEqual(
          result.prepare("SELECT sequence FROM orchestration_events ORDER BY sequence").all(),
          [
            { sequence: 10 },
            { sequence: 11 },
            { sequence: 12 },
            { sequence: 13 },
            { sequence: 14 },
          ],
        );
        result.close();

        assert.deepEqual(mergeT3StateDatabases({ sourcePath, destinationPath }), {
          projects: 0,
          threads: 0,
          skippedProjects: 4,
          skippedThreads: 5,
          projectIds: new Set(["project-existing", "project-incompatible", "project-new"]),
        });
        source.close();
        destination.close();
      }),
    ),
  );

  it.effect("adds only missing provider and valid project settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-settings-" });
        const sourcePath = path.join(root, "source.json");
        const destinationPath = path.join(root, "destination.json");
        yield* fs.writeFileString(
          sourcePath,
          '{"providerInstances":{"existing":{"driver":"source"},"new":{"driver":"codex","environment":[{"name":"TOKEN","sensitive":true}]}},"projectSettingsOverrides":{"project-new":{"defaultRuntimeMode":"plan"},"project-skipped":{"defaultRuntimeMode":"plan"}}}',
        );
        yield* fs.writeFileString(
          destinationPath,
          '{"providerInstances":{"existing":{"driver":"destination"}}}',
        );

        const result = yield* mergeT3Settings(
          sourcePath,
          destinationPath,
          new Set(["project-new"]),
        );
        const settings = decodeJson(yield* fs.readFileString(destinationPath)) as {
          readonly providerInstances: Record<string, { readonly driver: string }>;
          readonly projectSettingsOverrides: Record<string, unknown>;
        };

        assert.equal(result.count, 2);
        assert.deepEqual([...result.secretNames], ["provider-env-bmV3-VE9LRU4"]);
        assert.equal(settings.providerInstances.existing?.driver, "destination");
        assert.equal(settings.providerInstances.new?.driver, "codex");
        assert.deepEqual(Object.keys(settings.projectSettingsOverrides), ["project-new"]);
      }),
    ),
  );
});

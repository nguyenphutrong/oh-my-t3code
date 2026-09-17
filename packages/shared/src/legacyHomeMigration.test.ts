// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { migrateLegacyT3Home } from "./legacyHomeMigration.ts";

it.layer(NodeServices.layer)("legacy home migration", (it) => {
  it.effect("imports durable state from a live legacy database without copying runtime files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "legacy-home-migration-",
        });
        const sourceBaseDir = path.join(root, ".t3");
        const sourceStateDir = path.join(sourceBaseDir, "userdata");
        const destinationBaseDir = path.join(root, ".oh-my-t3code");
        const sourceDatabasePath = path.join(sourceStateDir, "state.sqlite");

        yield* fileSystem.makeDirectory(path.join(sourceStateDir, "secrets"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(sourceStateDir, "logs"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(destinationBaseDir, "runtime"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(sourceStateDir, "settings.json"),
          '{"providers":["codex"]}\n',
        );
        yield* fileSystem.writeFileString(
          path.join(sourceStateDir, "secrets", "provider.bin"),
          "provider-secret",
        );
        yield* fileSystem.writeFileString(path.join(sourceStateDir, "logs", "server.log"), "log");
        yield* fileSystem.writeFileString(
          path.join(sourceStateDir, "server-runtime.json"),
          '{"pid":123}\n',
        );
        yield* fileSystem.writeFileString(
          path.join(destinationBaseDir, "runtime", "installed"),
          "1",
        );

        const sourceDatabase = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(sourceDatabasePath)),
          (database) => Effect.sync(() => database.close()),
        );
        sourceDatabase.exec("PRAGMA journal_mode = WAL");
        sourceDatabase.exec("CREATE TABLE imported_threads (id TEXT PRIMARY KEY, title TEXT)");
        sourceDatabase
          .prepare("INSERT INTO imported_threads (id, title) VALUES (?, ?)")
          .run("thread-1", "Existing thread");

        const result = yield* migrateLegacyT3Home({ sourceBaseDir, destinationBaseDir });

        expect(result).toEqual({
          status: "migrated",
          entries: ["secrets", "settings.json", "state.sqlite"],
        });
        expect(
          yield* fileSystem.readFileString(
            path.join(destinationBaseDir, "userdata", "settings.json"),
          ),
        ).toContain("codex");
        expect(
          yield* fileSystem.readFileString(
            path.join(destinationBaseDir, "userdata", "secrets", "provider.bin"),
          ),
        ).toBe("provider-secret");
        expect(yield* fileSystem.exists(path.join(destinationBaseDir, "userdata", "logs"))).toBe(
          false,
        );
        expect(
          yield* fileSystem.exists(
            path.join(destinationBaseDir, "userdata", "server-runtime.json"),
          ),
        ).toBe(false);
        expect(
          yield* fileSystem.readFileString(path.join(destinationBaseDir, "runtime", "installed")),
        ).toBe("1");

        const importedDatabase = new NodeSqlite.DatabaseSync(
          path.join(destinationBaseDir, "userdata", "state.sqlite"),
          { readOnly: true },
        );
        try {
          assert.deepEqual(
            importedDatabase.prepare("SELECT id, title FROM imported_threads").all(),
            [{ id: "thread-1", title: "Existing thread" }],
          );
        } finally {
          importedDatabase.close();
        }
      }),
    ),
  );

  it.effect("does not overwrite an initialized fork home", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "legacy-home-existing-" });
        const sourceBaseDir = path.join(root, ".t3");
        const destinationBaseDir = path.join(root, ".oh-my-t3code");
        yield* fileSystem.makeDirectory(path.join(sourceBaseDir, "userdata"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(destinationBaseDir, "userdata"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(sourceBaseDir, "userdata", "settings.json"),
          "legacy",
        );
        yield* fileSystem.writeFileString(
          path.join(destinationBaseDir, "userdata", "settings.json"),
          "fork",
        );

        expect(yield* migrateLegacyT3Home({ sourceBaseDir, destinationBaseDir })).toEqual({
          status: "destination-initialized",
        });
        expect(
          yield* fileSystem.readFileString(
            path.join(destinationBaseDir, "userdata", "settings.json"),
          ),
        ).toBe("fork");
      }),
    ),
  );

  it.effect("does nothing when the legacy home has no durable state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "legacy-home-empty-" });
        const sourceBaseDir = path.join(root, ".t3");
        const destinationBaseDir = path.join(root, ".oh-my-t3code");
        yield* fileSystem.makeDirectory(path.join(sourceBaseDir, "userdata", "logs"), {
          recursive: true,
        });

        expect(yield* migrateLegacyT3Home({ sourceBaseDir, destinationBaseDir })).toEqual({
          status: "source-missing",
        });
        expect(yield* fileSystem.exists(path.join(destinationBaseDir, "userdata"))).toBe(false);
      }),
    ),
  );
});

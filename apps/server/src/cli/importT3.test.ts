import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { importT3Home, ImportT3Error } from "./importT3.ts";

it.layer(NodeServices.layer)("T3 Code import command", (it) => {
  it.effect("replaces initialized data and keeps the previous state as a backup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "import-t3-command-" });
        const sourceBaseDir = path.join(root, ".t3");
        const destinationBaseDir = path.join(root, ".oh-my-t3code");
        const sourceSettings = path.join(sourceBaseDir, "userdata", "settings.json");
        const destinationSettings = path.join(destinationBaseDir, "userdata", "settings.json");
        yield* fileSystem.makeDirectory(path.dirname(sourceSettings), { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(destinationSettings), { recursive: true });
        yield* fileSystem.writeFileString(sourceSettings, "latest-t3-state");
        yield* fileSystem.writeFileString(destinationSettings, "previous-fork-state");

        const result = yield* importT3Home({ sourceBaseDir, destinationBaseDir });

        assert.equal(yield* fileSystem.readFileString(destinationSettings), "latest-t3-state");
        assert.notEqual(result.backupStateDir, null);
        assert.equal(
          yield* fileSystem.readFileString(path.join(result.backupStateDir!, "settings.json")),
          "previous-fork-state",
        );
      }),
    ),
  );

  it.effect("refuses to replace data while the fork server is running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "import-t3-running-" });
        const sourceBaseDir = path.join(root, ".t3");
        const destinationBaseDir = path.join(root, ".oh-my-t3code");
        const sourceSettings = path.join(sourceBaseDir, "userdata", "settings.json");
        const destinationStateDir = path.join(destinationBaseDir, "userdata");
        const destinationSettings = path.join(destinationStateDir, "settings.json");
        yield* fileSystem.makeDirectory(path.dirname(sourceSettings), { recursive: true });
        yield* fileSystem.makeDirectory(destinationStateDir, { recursive: true });
        yield* fileSystem.writeFileString(sourceSettings, "latest-t3-state");
        yield* fileSystem.writeFileString(destinationSettings, "active-fork-state");
        yield* fileSystem.writeFileString(
          path.join(destinationStateDir, "server-runtime.json"),
          `{"version":1,"pid":${process.pid},"port":49749,"origin":"http://127.0.0.1:49749","startedAt":"2026-09-17T00:00:00.000Z"}\n`,
        );

        const error = yield* importT3Home({ sourceBaseDir, destinationBaseDir }).pipe(Effect.flip);

        assert.instanceOf(error, ImportT3Error);
        assert.equal(error.reason, "destination-running");
        assert.equal(yield* fileSystem.readFileString(destinationSettings), "active-fork-state");
      }),
    ),
  );
});

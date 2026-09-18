import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { discoverAmpSkills } from "./AmpProvider.ts";

it.effect("discovers Amp skills in the workspace", () =>
  Effect.gen(function* () {
    let cwd: string | undefined;
    let args: ReadonlyArray<string> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") {
        cwd = command.options.cwd;
        args = command.args;
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(
            Stream.make(
              JSON.stringify({
                skills: [
                  {
                    name: "deploy",
                    description: "Deploy this app.",
                    baseDir: "file:///repo/.agents/skills/deploy/",
                    source: "workspace-agents",
                  },
                ],
              }),
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });

    const skills = yield* discoverAmpSkills(
      { enabled: true, binaryPath: "amp", settingsFile: "/amp/settings.json" },
      {},
      "/repo",
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    expect(cwd).toBe("/repo");
    expect(args).toEqual(["skills", "list", "--json", "--settings-file", "/amp/settings.json"]);
    expect(skills).toEqual([
      {
        name: "deploy",
        description: "Deploy this app.",
        path: "file:///repo/.agents/skills/deploy/SKILL.md",
        scope: "workspace-agents",
        enabled: true,
      },
    ]);
  }),
);

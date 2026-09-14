import { AcpRegistrySettings, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AcpRegistryDriver,
  acpRegistryRuntimeOptions,
  acpRegistrySnapshotReadiness,
  buildAcpRegistrySnapshot,
} from "./AcpRegistryDriver.ts";

const settings = Schema.decodeSync(AcpRegistrySettings)({
  agentId: "example",
  customModels: ["custom"],
});

describe("AcpRegistryDriver", () => {
  it("exposes the registry defaults", () => {
    expect(AcpRegistryDriver.driverKind).toBe("acpRegistry");
    expect(AcpRegistryDriver.metadata.supportsMultipleInstances).toBe(true);
    expect(AcpRegistryDriver.defaultConfig()).toEqual({
      enabled: true,
      agentId: "",
      commandPath: "",
      launchArgs: "",
      authMethodId: "",
      distribution: "auto",
      customModels: [],
    });
  });

  it("maps catalog readiness statuses", () => {
    expect(
      acpRegistrySnapshotReadiness({
        status: "ready",
        agentId: "a",
        version: "1",
        distribution: "npx",
      }).status,
    ).toBe("ready");
    expect(
      acpRegistrySnapshotReadiness({
        status: "unprepared",
        agentId: "a",
        version: "1",
        distribution: "binary",
      }).status,
    ).toBe("warning");
    expect(
      acpRegistrySnapshotReadiness({
        status: "missing_runner",
        agentId: "a",
        version: "1",
        distribution: "uvx",
        runner: "uv",
      }),
    ).toMatchObject({ installed: false, status: "error" });
    expect(
      acpRegistrySnapshotReadiness({ status: "unsupported", agentId: "a", version: "1" }).message,
    ).toContain("platform");
  });

  it("distinguishes protocol and authentication failures and retains default/custom models", () => {
    const base = {
      instanceId: ProviderInstanceId.make("acpRegistry_example"),
      continuationKey: "acpRegistry:instance:acpRegistry_example",
      settings,
      checkedAt: "2026-01-01T00:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "example",
        version: "1",
        distribution: "npx",
      } as const,
    };
    const protocol = buildAcpRegistrySnapshot({
      ...base,
      probeError: new Error("invalid protocol response"),
    });
    expect(protocol).toMatchObject({
      installed: true,
      status: "error",
      auth: { status: "unknown" },
    });
    const auth = buildAcpRegistrySnapshot({
      ...base,
      probeError: new Error("authentication required (-32000)"),
    });
    expect(auth).toMatchObject({ status: "warning", auth: { status: "unauthenticated" } });
    expect(auth.models.map((model) => model.slug)).toEqual(["default", "custom"]);
  });

  it("wires resolved spawn, resume, MCP, capabilities, and lazy auth into the runtime", () => {
    const configured = { ...settings, authMethodId: "oauth" };
    const spawn = { command: "/managed/agent", args: ["--acp"], env: { TOKEN: "instance" } };
    const mcpServers = [{ name: "tools", command: "/bin/tools", args: [], env: [] }] as const;
    const options = acpRegistryRuntimeOptions(
      configured,
      { cwd: "/workspace", resumeSessionId: "session-1", resumeMethod: "load", mcpServers },
      spawn,
    );
    expect(options).toMatchObject({
      spawn,
      cwd: "/workspace",
      resumeSessionId: "session-1",
      resumeMethod: "load",
      authMethodId: "oauth",
      authenticateOnAuthRequired: true,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    expect(options.mcpServers).toBe(mcpServers);
  });
});

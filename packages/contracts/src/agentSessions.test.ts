import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentSessionScanInput,
  AgentSessionImportInput,
  AgentSessionScanResult,
  parseCodexSessionLink,
} from "./agentSessions.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);

describe("Codex session links", () => {
  const id = "019f9271-04da-7151-b23e-523c535a0a16";

  it("accepts a pasted link and normalizes its session ID", () => {
    expect(parseCodexSessionLink(`  codex://threads/${id.toUpperCase()}\n`)).toBe(id);
    expect(Schema.decodeUnknownSync(AgentSessionScanInput)({ codexSessionId: id })).toEqual({
      codexSessionId: id,
    });
    expect(
      Schema.decodeUnknownSync(AgentSessionImportInput)({
        projectId: "project-1",
        codexSessionId: id,
      }),
    ).toEqual({ projectId: "project-1", codexSessionId: id });
  });

  it.each([
    id,
    `https://threads/${id}`,
    `claude://threads/${id}`,
    `codex://sessions/${id}`,
    `codex://threads/${id}/extra`,
    `codex://threads/${id}?other=1`,
    "codex://threads/../../private",
    `codex://threads/${id.slice(1)}`,
  ])("rejects an invalid or unsupported link: %s", (link) => {
    expect(parseCodexSessionLink(link)).toBeNull();
  });

  it("rejects an invalid ID at the RPC boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentSessionScanInput)({ codexSessionId: "../session" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AgentSessionImportInput)({
        projectId: "project-1",
        codexSessionId: "",
      }),
    ).toThrow();
  });
});

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});

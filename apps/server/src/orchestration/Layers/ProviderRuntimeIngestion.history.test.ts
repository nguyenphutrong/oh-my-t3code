import { expect, it } from "@effect/vitest";

import { findMissingHistoryMessages } from "./ProviderRuntimeIngestion.ts";

it("finds a missing response without duplicating surrounding messages", () => {
  const synced = [
    {
      messageId: "import:amp:thread:user-1",
      role: "user" as const,
      text: "First prompt",
      createdAt: "2026-09-17T10:00:00.000Z",
    },
    {
      messageId: "import:amp:thread:assistant-1",
      role: "assistant" as const,
      text: "Missing response",
      createdAt: "2026-09-17T10:00:01.000Z",
    },
    {
      messageId: "import:amp:thread:user-2",
      role: "user" as const,
      text: "Second prompt",
      createdAt: "2026-09-17T10:01:00.000Z",
    },
    {
      messageId: "import:amp:thread:assistant-2",
      role: "assistant" as const,
      text: "Second response",
      createdAt: "2026-09-17T10:01:01.000Z",
    },
  ];

  expect(
    findMissingHistoryMessages(
      [
        { id: "local-user-1", role: "user", text: "First prompt" },
        { id: "local-user-2", role: "user", text: "Second prompt" },
        { id: "local-assistant-2", role: "assistant", text: "Second response" },
      ],
      synced,
    ),
  ).toEqual([synced[1]]);

  expect(
    findMissingHistoryMessages(
      synced.map((message) => ({ id: message.messageId, role: message.role, text: message.text })),
      synced,
    ),
  ).toEqual([]);
});

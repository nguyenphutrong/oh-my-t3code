import {
  assignProjectKeysToSpace,
  assignThreadKeysToSpace,
  derivePhysicalProjectKeyFromPath,
} from "@t3tools/client-runtime/state/project-grouping";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

import { useUiStateStore } from "../uiStateStore";
import { getClientSettings, useUpdateClientSettings } from "./useSettings";

export function useAssignProjectToActiveSpace() {
  const updateClientSettings = useUpdateClientSettings();

  return useCallback(
    (environmentId: EnvironmentId, workspaceRoot: string) => {
      const activeSpaceId = useUiStateStore.getState().sidebarSpaceId;
      if (activeSpaceId === null) return;

      const { projectSpaces } = getClientSettings();
      const activeSpace = projectSpaces.find((space) => space.id === activeSpaceId);
      const projectKey = derivePhysicalProjectKeyFromPath(environmentId, workspaceRoot);
      if (!activeSpace || activeSpace.projectKeys.includes(projectKey)) return;

      void updateClientSettings({
        projectSpaces: assignProjectKeysToSpace(projectSpaces, activeSpaceId, [projectKey]),
      });
    },
    [updateClientSettings],
  );
}

export function useAssignThreadToSpace() {
  const updateClientSettings = useUpdateClientSettings();

  return useCallback(
    (spaceId: string | null, environmentId: EnvironmentId, threadId: ThreadId) => {
      if (spaceId === null) return;

      const { projectSpaces } = getClientSettings();
      const targetSpace = projectSpaces.find((space) => space.id === spaceId);
      const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
      if (!targetSpace || targetSpace.threadKeys?.includes(threadKey)) return;

      void updateClientSettings({
        projectSpaces: assignThreadKeysToSpace(projectSpaces, spaceId, [threadKey]),
      });
    },
    [updateClientSettings],
  );
}

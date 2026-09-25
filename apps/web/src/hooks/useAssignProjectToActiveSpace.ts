import {
  assignProjectKeysToSpace,
  derivePhysicalProjectKeyFromPath,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentId } from "@t3tools/contracts";
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

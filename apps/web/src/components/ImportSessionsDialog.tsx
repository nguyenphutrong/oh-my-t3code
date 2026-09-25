import { CommandId, parseCodexSessionLink, type EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

import {
  useAssignProjectToActiveSpace,
  useAssignThreadToSpace,
} from "../hooks/useAssignProjectToActiveSpace";
import { newProjectId } from "../lib/utils";
import { resolveOnboardingProjectId } from "../onboarding/projectImport.logic";
import { agentSessionImport, agentSessionScan } from "../state/agentSessions";
import { readProjects, useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useDebouncedValue } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { waitForStartedServerThread } from "./ChatView.logic";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";

export function ImportSessionsDialog({ onClose }: { readonly onClose: () => void }) {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId ?? environments[0]?.environmentId ?? null,
  );
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const pending = useRef(false);
  const projects = useProjects();
  const codexSessionId = parseCodexSessionLink(link);
  const debouncedSessionId = useDebouncedValue(codexSessionId, 300);
  const scan = useEnvironmentQuery(
    useMemo(
      () =>
        environmentId !== null && codexSessionId !== null && codexSessionId === debouncedSessionId
          ? agentSessionScan({ environmentId, input: { codexSessionId } })
          : null,
      [environmentId, codexSessionId, debouncedSessionId],
    ),
  );
  const isChecking =
    environmentId !== null &&
    codexSessionId !== null &&
    (scan.isPending || (scan.data === null && scan.error === null));
  const candidate =
    !isChecking && scan.error === null && scan.data?.candidates.length === 1
      ? scan.data.candidates[0]!
      : null;
  let previewError = "";
  if (link.trim()) {
    if (codexSessionId === null) {
      previewError = "Enter a Codex session link: codex://threads/<session-id>.";
    } else if (environmentId === null) {
      previewError = "Connect the computer that holds this Codex session first.";
    } else if (scan.error !== null) {
      previewError =
        "Could not look up the session. Check the computer's connection and try again.";
    } else if (!isChecking && scan.data?.candidates.length === 0) {
      previewError =
        "Session not found. Check that this computer has the Codex transcript and its project folder still exists.";
    } else if (!isChecking && candidate === null) {
      previewError =
        "This session was found in multiple project folders. Check the Codex homes configured on this computer.";
    }
  }
  const existingProjectId =
    candidate !== null && environmentId !== null
      ? resolveOnboardingProjectId(projects, environmentId, candidate)
      : null;
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importSession = useAtomCommand(agentSessionImport, { reportFailure: false });
  const assignProjectToActiveSpace = useAssignProjectToActiveSpace();
  const assignThreadToSpace = useAssignThreadToSpace();

  const submit = async () => {
    if (pending.current || candidate === null || codexSessionId === null || environmentId === null)
      return;
    pending.current = true;
    const requestedSpaceId = useUiStateStore.getState().sidebarSpaceId;
    setIsImporting(true);
    setError("");
    try {
      let projectId = resolveOnboardingProjectId(readProjects(), environmentId, candidate);
      if (projectId === null) {
        projectId = newProjectId();
        const created = await createProject({
          environmentId,
          input: {
            projectId,
            commandId: CommandId.make(`session-import:project:create:${projectId}`),
            title: candidate.title,
            workspaceRoot: candidate.path,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (created._tag !== "Success") {
          setError("Could not create the project. Try importing again.");
          return;
        }
        assignProjectToActiveSpace(environmentId, candidate.path);
      }
      const imported = await importSession({
        environmentId,
        input: { projectId, expectedWorkspaceRoot: candidate.path, codexSessionId },
      });
      if (
        imported._tag !== "Success" ||
        imported.value.importedCount === 0 ||
        imported.value.skippedCount > 0 ||
        imported.value.threadId === undefined
      ) {
        setError(
          "Could not import the session history. The transcript may be missing, unreadable, or too large.",
        );
        return;
      }
      assignThreadToSpace(requestedSpaceId, environmentId, imported.value.threadId);
      const threadRef = scopeThreadRef(environmentId, imported.value.threadId);
      if (!(await waitForStartedServerThread(threadRef, 10_000))) {
        setError(
          "Session imported, but its history has not synced yet. Try importing again to open it.",
        );
        return;
      }
      useUiStateStore.getState().setSidebarProjectScopeKey(null);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
      toastManager.add({
        type: "success",
        title: "Session imported",
        description: candidate.title,
      });
      onClose();
    } catch {
      setError("Import failed. Check the computer's connection and try again.");
    } finally {
      pending.current = false;
      setIsImporting(false);
    }
  };

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open, event) => {
        if (pending.current) event.cancel();
        else if (!open) onClose();
      }}
    >
      <DialogPopup className="p-6" showCloseButton={!isImporting}>
        <DialogTitle>Import sessions</DialogTitle>
        <p className="mt-2 text-sm text-muted-foreground">
          Paste a Codex session link to check it before importing. Its history must be on the
          selected computer. Nothing is imported until you confirm.
        </p>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {environments.length > 1 ? (
            <Select
              value={environmentId}
              onValueChange={(value) => {
                setEnvironmentId(value);
                setError("");
              }}
              disabled={isImporting}
            >
              <SelectTrigger aria-label="Computer">
                <SelectValue>
                  {environments.find((entry) => entry.environmentId === environmentId)?.label ??
                    "Choose a computer"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environments.map((entry) => (
                  <SelectItem key={entry.environmentId} value={entry.environmentId}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <label className="block space-y-2 text-sm">
            <span>Session link</span>
            <Input
              autoFocus
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setError("");
              }}
              disabled={isImporting}
              placeholder="codex://threads/019f9271-04da-7151-b23e-523c535a0a16"
            />
          </label>
          {isChecking ? (
            <p role="status" className="text-sm text-muted-foreground">
              Checking session…
            </p>
          ) : null}
          {candidate !== null ? (
            <section
              aria-label="Session preview"
              className="space-y-3 rounded-lg border border-border bg-muted/30 p-4 text-sm"
            >
              <p className="font-medium">Session found</p>
              <dl className="space-y-2">
                <div>
                  <dt className="text-muted-foreground">Project</dt>
                  <dd className="break-words font-medium">{candidate.title}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Folder</dt>
                  <dd className="break-all font-mono text-xs">{candidate.path}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Codex session</dt>
                  <dd className="break-all font-mono text-xs">{codexSessionId}</dd>
                </div>
                {candidate.lastActiveAt !== null ? (
                  <div>
                    <dt className="text-muted-foreground">Last active</dt>
                    <dd>{new Date(candidate.lastActiveAt).toLocaleString()}</dd>
                  </div>
                ) : null}
              </dl>
              <p>
                {existingProjectId !== null
                  ? "Import into the existing project."
                  : "A new project will be created for this folder."}
              </p>
            </section>
          ) : null}
          {previewError || error ? (
            <p role="alert" className="text-sm text-destructive">
              {previewError || error}
            </p>
          ) : null}
          {scan.error !== null || scan.data?.candidates.length === 0 ? (
            <Button
              type="button"
              variant="ghost"
              disabled={isChecking || isImporting}
              onClick={() => {
                setError("");
                scan.refresh();
              }}
            >
              Check again
            </Button>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={isImporting} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isImporting || candidate === null}>
              {isImporting ? "Importing…" : "Import session"}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

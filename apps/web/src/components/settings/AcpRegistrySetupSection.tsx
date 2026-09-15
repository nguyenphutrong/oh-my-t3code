import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function configuredAcpRegistryAgentId(config: unknown): string | null {
  if (config === null || typeof config !== "object" || !("agentId" in config)) return null;
  const agentId = (config as Record<string, unknown>).agentId;
  return typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
}

export function AcpRegistrySetupSection({
  environmentId,
  agentId,
  provider,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly agentId: string | null;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
}) {
  const prepareAgent = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const prepare = async () => {
    if (!agentId || preparing) return;
    setPreparing(true);
    setMessage(null);
    const result = await prepareAgent({ environmentId, input: { agentId } });
    if (result._tag === "Success") {
      const refreshed = await refreshProviders({
        environmentId,
        input: {
          ...(provider ? { instanceId: provider.instanceId } : {}),
          refreshModels: true,
        },
      });
      const refreshedProvider =
        refreshed._tag === "Success"
          ? refreshed.value.providers.find(
              (candidate) => candidate.instanceId === provider?.instanceId,
            )
          : undefined;
      setMessage(
        refreshedProvider?.status === "ready"
          ? `Prepared and verified ${result.value.agentId} v${result.value.version}.`
          : `Prepared ${result.value.agentId} v${result.value.version}, but its health check did not pass.`,
      );
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setMessage(error instanceof Error ? error.message : "The ACP agent could not be prepared.");
    }
    setPreparing(false);
  };

  return (
    <section aria-label="ACP Registry setup" className="grid gap-3 text-xs">
      <p className="text-muted-foreground">
        Registry agents are third-party programs and are not sandboxed by T3 Code.
      </p>
      {agentId ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {provider?.installed
              ? `${agentId} is prepared on this environment.`
              : `${agentId} needs to be prepared before use.`}
          </span>
          {!readOnly ? (
            <Button disabled={preparing} onClick={() => void prepare()} size="xs" variant="outline">
              {preparing
                ? "Preparing…"
                : provider?.installed
                  ? "Check for updates"
                  : "Prepare agent"}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground">
          Choose an agent ID or configure a custom executable.
        </p>
      )}
      {message ? <p className="text-muted-foreground">{message}</p> : null}
    </section>
  );
}

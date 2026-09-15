import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AcpRegistryPrepareResult,
  AcpRegistrySearchAgent,
  EnvironmentId,
  ProviderInstanceConfig,
} from "@t3tools/contracts";
import { ExternalLinkIcon, SearchIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { ACPRegistryIcon } from "../Icons";
import { isConfiguredAcpRegistryAgent } from "./AddProviderInstanceDialog.logic";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The ACP agent could not be prepared.";
}

function applyPrepareResult(
  agent: AcpRegistrySearchAgent,
  prepared: AcpRegistryPrepareResult,
): AcpRegistrySearchAgent {
  return {
    ...agent,
    id: prepared.agentId,
    version: prepared.version,
    distribution: prepared.distribution,
  };
}

export function AcpRegistrySearchStep({
  environmentId,
  providerInstances,
  onPrepared,
  onManualConfiguration,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly onPrepared: (agent: AcpRegistrySearchAgent) => void;
  readonly onManualConfiguration: () => void;
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const search = useEnvironmentQuery(
    serverEnvironment.searchAcpRegistry({
      environmentId,
      input: { query: submittedQuery },
    }),
  );
  const prepareAgent = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    setPrepareError(null);
    if (trimmed === submittedQuery) search.refresh();
    else setSubmittedQuery(trimmed);
  };

  const prepare = async (agent: AcpRegistrySearchAgent) => {
    setPrepareError(null);
    setPreparingId(agent.id);
    const result = await prepareAgent({ environmentId, input: { agentId: agent.id } });
    setPreparingId(null);
    if (result._tag === "Success") {
      onPrepared(applyPrepareResult(agent, result.value));
    } else if (!isAtomCommandInterrupted(result)) {
      setPrepareError(errorMessage(squashAtomCommandFailure(result)));
    }
  };

  const results = search.data?.agents ?? null;
  return (
    <section className="grid gap-3" aria-labelledby="acp-registry-search-heading">
      <div>
        <h3 id="acp-registry-search-heading" className="text-sm font-medium text-foreground">
          Find an ACP agent
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Compatible agents from the official ACP Registry. Amp appears first when available.
        </p>
      </div>
      <form className="flex gap-2" onSubmit={submitSearch}>
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search ACP Registry"
            className="bg-background pl-8"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search agents, authors, or descriptions"
            type="search"
            value={query}
          />
        </div>
        <Button disabled={search.isPending || preparingId !== null} type="submit" variant="outline">
          Search
        </Button>
      </form>
      {search.error || prepareError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {prepareError ?? search.error}
        </div>
      ) : null}
      {search.isPending && results === null ? (
        <div className="py-6 text-center text-sm text-muted-foreground">Loading registry…</div>
      ) : null}
      {results ? (
        results.length === 0 ? (
          <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No compatible agents found.
          </div>
        ) : (
          <ScrollArea scrollFade className="max-h-64 border-y border-border/70">
            <div className="divide-y divide-border/70 pr-2">
              {results.map((agent) => {
                const alreadyAdded = isConfiguredAcpRegistryAgent(providerInstances, agent.id);
                const isAmp = agent.id === "amp-acp";
                return (
                  <article key={agent.id} className="grid gap-2 py-3">
                    <div className="flex items-start gap-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
                        <ACPRegistryIcon className="size-4" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{agent.name}</span>
                          <span className="text-[11px] text-muted-foreground">
                            v{agent.version}
                          </span>
                          {isAmp ? (
                            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning-foreground">
                              Community Amp wrapper
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {agent.description || "ACP-compatible coding agent."}
                        </p>
                      </div>
                      <Button
                        disabled={alreadyAdded || preparingId !== null}
                        onClick={() => void prepare(agent)}
                        size="xs"
                        variant="outline"
                      >
                        {alreadyAdded
                          ? "Added"
                          : preparingId === agent.id
                            ? agent.distribution === "binary"
                              ? "Downloading…"
                              : "Preparing…"
                            : "Select"}
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2 pl-11 text-[11px] text-muted-foreground">
                      <span>{agent.distribution}</span>
                      <span>
                        {agent.integrity === "sha256" ? "Checksum verified" : "Registry package"}
                      </span>
                      {agent.website ? (
                        <a
                          href={agent.website}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          Docs <ExternalLinkIcon className="size-3" />
                        </a>
                      ) : null}
                      {agent.repository ? (
                        <a
                          href={agent.repository}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          Source <ExternalLinkIcon className="size-3" />
                        </a>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </ScrollArea>
        )
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          Third-party agents run with the same local access as their process. Review their source
          before use.
        </p>
        <Button onClick={onManualConfiguration} size="xs" variant="ghost">
          Configure manually
        </Button>
      </div>
    </section>
  );
}

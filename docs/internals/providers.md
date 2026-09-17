# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Generic ACP Registry boundary

The [ACP Registry catalog](../../apps/server/src/provider/acp/AcpRegistrySupport.ts) is a
server-lifetime service shared by RPC discovery and provider hydration. It accepts only the
published registry schema, bounded HTTPS responses without credentials, exact package versions,
and platform-specific distributions. Managed archives are checksum-verified and extracted with
path, link, and size checks into an atomic version directory. Registry metadata never becomes a
shell command: executable and argument vectors remain separate through process spawn.

The [registry driver](../../apps/server/src/provider/Drivers/AcpRegistryDriver.ts) resolves one
configured agent and creates the [generic ACP adapter](../../apps/server/src/provider/Layers/GenericAcpAdapter.ts).
The adapter owns process/session scopes and normalizes ACP content, plans, tool updates, and
permission requests into provider runtime events. Files are constrained to ACP-requested text
operations; terminals have concurrency, retained-process, and output limits. A process exit closes
only its session, so it cannot fail the provider registry or another provider instance.

Health checks stop after `initialize`: they must not create a session, start MCP servers, or trigger
interactive authentication. Session startup first tries the ACP operation and authenticates only
after the standard `-32000` auth-required response. Existing Cursor, Grok, and Antigravity adapters
keep their provider-specific eager authentication behavior.

ACP capabilities are negotiated at runtime. Unsupported snapshot/rollback and structured
elicitation operations return explicit adapter validation errors; they are not emulated. Generic
ACP image blocks are capped at 8 MiB. Registry agents remain trusted local programs rather than a
sandbox boundary.

## Native Amp CLI boundary

The native Amp driver runs the official Amp CLI directly rather than routing through ACP. The
[adapter](../../apps/server/src/provider/Layers/AmpAdapter.ts) owns T3 sessions and maps CLI
system, assistant, tool, result, usage, cancellation, and explicit Amp thread IDs into the shared
provider runtime. The community `amp-acp` registry entry remains an independent provider instance;
there is no implicit migration between the two continuation formats.

The [CLI runtime boundary](../../apps/server/src/provider/Layers/AmpCliRuntime.ts) spawns the
configured executable with argument vectors, never a shell-built command. It uses `--execute`,
`--stream-json-thinking`, and `--stream-json-input`; validates every JSONL message; caps each
message at 1 MiB; bounds stderr; and terminates the child when a turn is cancelled or its scope
closes. Custom executable paths are process-local and do not require mutating `AMP_CLI_PATH`.

Amp threads use private visibility, disable archive-on-execute, and always continue a concrete
thread ID. Streaming input carries text and supported image blocks. The CLI still provides no auth
status API, model catalog, conversation snapshot, rollback operation, or in-process permission
callback. Health checks therefore inspect only `amp --version` and an explicitly supplied
`AMP_API_KEY`; they never read Amp credential files. Full access maps to
`--dangerously-allow-all`, while other modes retain Amp's non-interactive permission behavior and
normalize reported denials. Tool-denied text-generation calls use a scope-owned temporary settings
file, preserving unrelated user settings and removing the file after the child exits.

## Process and account isolation

T3-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
T3's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).

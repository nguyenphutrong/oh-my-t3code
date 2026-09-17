# Amp

T3 Code supports Amp as a native provider by running the official Amp CLI in its documented
streaming JSON mode. This integration is separate from the community `amp-acp` entry in ACP
Registry; existing `amp-acp` instances are not changed or migrated.

## Set up Amp

1. Install the [Amp CLI](https://ampcode.com/manual#installation) on the machine running the T3
   Code environment.
2. Authenticate with Amp, or create an API key in Amp Security Settings and add it as
   `AMP_API_KEY`.
3. In the web or desktop client, open **Settings → Providers → Add provider instance** and choose
   **Amp**.
4. Keep **Binary path** as `amp`, or enter the full path to another Amp installation. Optionally
   select an Amp settings file.
5. When using `AMP_API_KEY`, add it under **Environment variables** and mark it **Secret**. T3 Code
   stores the value in its secret store and does not display it after saving.

Amp authentication remains owned by Amp. T3 Code does not read or copy Amp's cached credentials.
Provider health can confirm the CLI version and an explicitly configured API key, but it reports
cached-login state as unknown rather than inspecting credential files.

## Modes and sessions

The model picker exposes Amp's **Low**, **Medium**, **High**, and **Ultra** modes, plus Amp's
reasoning effort values. T3 Code stores Amp's explicit thread ID and uses it for later
turns, so continuation never depends on whichever Amp thread happened to run most recently.

Threads are created with private visibility and are not archived automatically when a turn
finishes. Full access maps to Amp's `--dangerously-allow-all` option. In other permission modes,
Amp uses its non-interactive permission policy; denied tools appear in the conversation, but the
CLI streaming protocol does not expose an interactive callback for T3 Code approval cards.

Text and PNG, JPEG, GIF, or WebP image attachments are sent through `--stream-json-input`. Other
file attachments are rejected before Amp starts. Amp streams complete message blocks and thinking
blocks rather than token deltas, so content appears as each CLI message arrives.

Provider setup is managed from web or desktop. Mobile can select configured Amp instances and
their modes when starting or updating a thread.

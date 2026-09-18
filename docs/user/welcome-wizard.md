# Welcome wizard

T3 Code shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow.

## Connect your computers

Select one or more computers to set up. If you opened T3 Code directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **T3 Connect** connects computers that are signed in to your account. Run
  `oh-my-t3code connect` on each computer you want to add, then start Oh My T3Code or run
  `oh-my-t3code serve` so the computer stays available. This fork does not currently operate the
  required relay, so use direct pairing unless you configured a fork-owned relay.
- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `oh-my-t3code serve`, then run `oh-my-t3code pair --tailscale` and
  paste the pairing link. You can also run `oh-my-t3code serve --host <address>` and
  use `oh-my-t3code pair` when the server is already reachable on your network.

Saved computers and computers discovered through T3 Connect are selected by
default. Uncheck any you do not want to set up; this does not disconnect them.
Continue when your selected computers are connected. Setup checks
agents across the selected computers, then offers project import grouped by computer.

If T3 Code cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If T3 Code cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check your agents

T3 Code checks each selected computer for Claude Code and Codex. If an agent is
not installed or signed in, select its action to open a terminal with the
correct command ready to run. Install uses the vendor's standalone installer,
which does not need Node or npm and keeps **Update now** working in Settings.
Other providers can be enabled in Settings.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

## Import your projects

After setup, open the command menu (Cmd+K on macOS, Ctrl+K on Windows/Linux)
and choose **Import sessions**, then paste a link such as
`codex://threads/019f9271-04da-7151-b23e-523c535a0a16`. If you have multiple
computers, select the one holding the Codex transcript. The link is not a cloud
download: that computer must still have the session history and project folder.
T3 Code checks the link automatically and previews the destination project.
Review it, then choose **Import session** to confirm; checking a link does not
create a project or import history.
T3 Code imports only that session, including history older than 30 days, and
reuses the matching project or creates one if needed. Direct links currently
support Codex; the setup flow below also imports Claude Code history.

T3 Code finds directories that Claude Code or Codex has used. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the
group shows the repository as `owner/name`. Clones with the same remote share
one group. Directories that are not git repositories sit under "Other folders".

The default selection includes git repositories active within the last 30 days
with at least three conversations. Use the checkboxes, or "Select all" and
"Select none", to change the selection. Linked git worktrees, Codex scratch
directories under `Documents/Codex`, and anything under `Downloads` are not
offered.

A large or malformed history can reach the scan limit. T3 Code keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Codex and Claude conversations active within the last
30 days. You can continue those conversations in T3 Code.

Conversation import is best effort. T3 Code keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so T3 Code does not remove user text. It reads one conversation at
a time and skips files larger than 16 MiB. It ignores malformed records and skips
unreadable or unparseable conversations.

Each import attempt reads up to 100 conversation files and 64 MiB per project,
with up to 100,000 input records. Run import again to continue a large batch.
Completed conversations are not imported again. You can continue without the
remaining history.

You can continue without configuring agents or importing projects, or return to an earlier step
using the setup progress bar. Navigation pauses while an import is running.

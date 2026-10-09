---
title: The workspace
description: The Greenhouse IDE, the shared chat thread, the editor, the review panel, the terminal dock and the keyboard shortcuts.
sidebar:
  order: 4
---

Opening a machine opens its workspace: a full-height IDE with a title bar across
the top, the sidebar on the left and the centre and right panels floating beside
it.

| Region            | What it holds                                                                       |
| ----------------- | ----------------------------------------------------------------------------------- |
| **Title bar**     | Back and forward, where you are, the people here, and the session's actions.        |
| **Sidebar**       | The machine switcher, navigation, and every session grouped by repository.          |
| **Centre**        | The session's tabs: its chats, open files, diffs and previews.                      |
| **Right panel**   | Files, changes, checks and review comments for the session, over the terminal dock. |
| **Terminal dock** | Setup and run script output, terminals and listening ports.                         |

Every split is resizable by dragging or with the keyboard, and the sizes are
remembered. Below 960 pixels wide the workspace becomes a single column for
reviewing on a phone: sessions, transcript and changes, without the editor or
terminals.

## Title bar

The breadcrumb reads `machine › repo › session`. The machine shows its runner
(the Vercel triangle or a Kubernetes box) and a status dot, and goes home. The
repository shows its icon; hover it to see the GitHub repository it pushes to.
The session title opens the session menu:

- **Rename**, **Archive** and **Delete** (keeping the branch or deleting it too).
- **Fork session.** A new session branched from this one's branch, for trying a
  different approach from the same point.
- **Copy share link.** See [Sharing](/greenhouse/sharing/).
- **Deploy preview.** See [Previews](/greenhouse/previews/#deploy-a-session-as-a-preview-environment).

On the right: the people here (click someone to follow them), the preview,
**Open in** for your editor, the pull request button, **Share**, and the right
panel toggle.

## Sidebar

- **Machine switcher.** The current machine, its runner and its status. The menu
  switches machines, shows live CPU, memory and disk against the machine's limits,
  starts or stops it, opens machine settings, forks it, and creates a new machine.
- **Home.** The launch composer and your recent sessions across machines,
  including machines shared with you.
- **New session** (**⌘N**) and **Search** (**⌘K**).
- **Repositories.** One group per repository cloned on the machine, with a **+**
  to start a session in it. **Add repository** clones another one.
- **Sessions.** Each row shows what the agent is doing and the title, and under
  it the branch, when it last changed, and the diffstat against the base branch
  (`+42 −7`). Hover a row to archive it or open its menu. Archived sessions
  collapse under **Archived**.
- **Footer.** You and **Settings** (**⌘,**). Help lives in the machine menu.

A session's status glyph tells you whether the agent is **working**, **waiting
for you**, idle, or whether the work is **done** (its pull request merged). A
pencil means you have an unsent draft in its composer.

A session's menu (the **⋯** on hover, or right-click) renames it, copies its
branch name, opens its pull request, archives it, or deletes it with or without
its branch.

Each repository has an icon, its initial on a coloured tile until someone picks
one. Right-click a repository, or use the **⋯** on hover, and choose **Change
icon…** to pick a symbol, an emoji, or the GitHub owner's avatar. The icon lives
in the repository's own git config as `orchard.icon`, so everyone on the machine
sees the same one (run `git config --unset orchard.icon` in a terminal to clear
it by hand). Read-only guests cannot change it.

## Settings

**⌘,** or the gear in the sidebar footer opens settings.

| Section          | What it holds                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **General**      | The machine's name, runner and size.                                                                                      |
| **Setup script** | The script that runs on every start. See [Machines](/greenhouse/machines/).                                               |
| **Projects**     | Orchard projects whose environment variables the machine gets. See [Projects](/greenhouse/projects/).                     |
| **Usage**        | Live CPU, memory and disk against the machine's limits, uptime, idle sleep and network.                                   |
| **Danger zone**  | Delete the machine. Host only.                                                                                            |
| **Preferences**  | Send with Enter or ⌘Enter, queue or steer follow-ups, notifications, context usage, MCP status, tool calls and reasoning. |
| **Sounds**       | What plays when an agent finishes, needs you, or fails. Follows Orchard's sound setting.                                  |
| **Appearance**   | Theme, zoom, chat text size, sidebar diff colours, mono font, ligatures, code size and terminal font.                     |
| **Git**          | The prefix for new session branches, and whether archiving deletes the branch.                                            |
| **Agents**       | The Claude account the machine's agent uses, its plan and its limits.                                                     |
| **Integrations** | Your GitHub, Linear and Slack links.                                                                                      |
| **Shortcuts**    | Every keyboard shortcut.                                                                                                  |

Machine sections are read-only for guests. Everything under **You** is yours
alone and is kept in this browser.

**Hold the applause** cuts openers like "You're absolutely right!" from agent
replies. It only changes what you see; the transcript is untouched.

## Centre

### Tabs

The first tabs are the session's **chats**. **+** starts another chat in the same
worktree, useful for a side question that should not derail the main thread.
Files you open and diffs you click appear as tabs next to them, with a dot while
they have unsaved changes. Close a tab with its **×** or a middle click; drag to
reorder.

**Checkpoints** (the history button at the end of the tab strip) lists the
prompts of the current chat. Rolling back to one undoes everything the agent did
after it.

## The chat thread

Each chat is one shared thread, visible to everyone in the session, like a group
chat with the agent in it.

- **Plain text is a prompt.** It goes to the agent and shows in the thread as your
  message, with your avatar. Everyone sees who asked for what.
- **`/chat <message>` is a comment.** It goes to the people in the session, not to
  the agent. Comments are stored with the session and appear in the thread in
  time order between prompts and answers. **Comment to the people here** in the
  composer menu starts one for you.

### What the agent shows

The agent's answer is the one thing each turn emphasises. Everything procedural,
its thinking, the commands it ran, the files it read and wrote, its sub-agents,
collapses into **one activity row** per turn, such as
`Worked for 48s · 6 steps · +12 −3`. While the turn is running the row shows the
single step in progress. Expand it to see every step.

Under each turn a quiet footer gives the time and duration, a copy button and
chips for the files that turn changed. Click a chip to open the file's diff.

### Permissions and questions

When the agent needs a decision it waits, and a card appears above the composer.
The session shows as needing input until someone answers.

- **Permission cards** say what the agent wants to do: run a command, edit a file
  (with a preview of the change), fetch a page or work outside the worktree.
  **Allow** lets it through once, **Always allow** stops asking for that kind of
  request until the agent restarts, and **Deny** stops the agent. Type what it should do instead before
  you deny and it carries on with that.
- **Question cards** list the agent's options. Pick one, or several when it
  asks for more than one, or type your own under **Other**. **Skip** dismisses
  the question and stops the agent.
- **Plan ready.** In plan mode the agent asks before it starts editing.
  **Start building** switches it to build mode, **Keep planning** keeps it
  read only, or type feedback to send instead.

With a card focused, **Enter** allows or submits, **⌘Enter** always allows,
**Escape** starts a denial (Enter sends it) and **1** to **9** pick an option.
A card takes focus when it appears, unless you are typing.

The composer stays usable while a card is open, so you can still steer the
agent. Once answered, the card leaves a quiet line in the thread, such as
`Allowed npm test`, with the avatar of whoever answered.

Read-only guests see the cards but cannot answer them. **Auto-accept
permissions** in Settings allows every permission request in chats where you
sent the last prompt. Questions still wait for you.

### The composer

- **Enter** sends; **Shift+Enter** adds a new line.
- **Escape** stops the agent while it is working.
- The model menu picks the model and effort for the next prompt. **Plan mode**
  runs the agent read only, so it proposes a plan instead of editing.
- **Attach** adds files or images (up to 10, 5 MB each), or drop them on the
  composer.
- Typing **/** lists the agent's commands, plus `/chat`; **Tab** completes one.
- A ring shows how much of the model's context the chat has used.

**Queued prompts.** Send while the agent is still working and your prompt waits
as a chip above the composer. Queued prompts go out one at a time as each turn
ends. Edit or remove a chip before it sends, or send it right away once the agent
is idle.

**Typing.** When a teammate is writing a prompt you see `Alex is typing…` above
the composer with their draft as they type. Nothing is sent until they press
Enter.

## Editor

Files open in Monaco, the editor from VS Code, with syntax highlighting, search,
multiple cursors and the shortcuts you already know. **⌘S** saves. Files up to
500 KB can be edited in the browser; open anything larger over SSH.

When a teammate has the same file open, you edit it together: their cursor and
selection show in their colour with their name, and changes merge as you type.
Edits the agent makes on disk are merged into the open file as well, so nobody's
work is overwritten. Shared files save automatically a couple of seconds after
the last change.

### Diffs and review comments

Clicking a changed file opens its diff against `HEAD`. Click a line number to
leave a comment on that line. Comments collect in the **Review** tab of the right
panel, grouped by file. Collaborators see your draft comments as you write them.

When you have a few, **Send review to agent** turns every comment into one
structured prompt, with each file, line and the line's text, and queues it. The
agent then works through them as one request.

## Right panel

| Tab           | What it shows                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **All files** | The worktree as a tree with git decorations. Right-click to create, rename or delete files and folders, copy a path, or open a file.                  |
| **Changes**   | Changed files with line counts. Click one for its diff. A commit box at the top commits (**⌘Enter**); counters show what is ahead and behind.         |
| **Checks**    | The pull request's state and its CI checks, with the failing logs and **Fix with agent**. See [Pull requests and checks](/greenhouse/pull-requests/). |
| **Review**    | Your diff comments, ready to send to the agent.                                                                                                       |

**⌘⇧G** jumps to Changes. **⌘⌥B** hides or shows the whole panel.

Commits from the Changes tab are made as you: your name and email from your
linked GitHub account. When several people prompted the agent in the session,
the commit carries a `Co-authored-by` trailer for each of them. See
[your own git identity](/greenhouse/sharing/#everyone-commits-as-themselves).

## Terminal dock

The dock sits under the right panel. **⌘J** collapses or expands it.

| Tab          | What it is                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup**    | The live output of the session's setup script. Read only.                                                                                                                                                                   |
| **Run**      | The output of the run script, with **Run** to start it and a stop button. See [Setup and run scripts](/greenhouse/scripts/).                                                                                                |
| **Terminal** | A shell in the session's worktree. **+** opens another; **⌘`** jumps to the terminal.                                                                                                                                       |
| **Ports**    | Every port a process on the machine is listening on, with which process, whether it belongs to this session, and **Open preview**. Ports declared in `.orchard/greenhouse.json` are listed before anything listens on them. |

Terminals run inside `tmux` on the machine, so they survive a page reload, a
dropped connection or switching machines: come back and you are attached to the
same shell with its scrollback. They use the same terminal as Orchard's pod
shells, with predictive echo so typing feels local on a slow link.

Terminals are per person. Your terminal tabs are your own shells, with your git
name, email and GitHub credential set up, so `git commit` and `git push` typed in
them are yours. You can open a teammate's terminal to watch it, read only, and
they can watch yours. The **Setup** and **Run** tabs are the same for everyone in
the session.

## Keyboard shortcuts

On Windows and Linux, use **Ctrl** for **⌘**.

| Shortcut           | Does                                                |
| ------------------ | --------------------------------------------------- |
| **⌘N**             | New session in the current repository               |
| **⌘K**             | Search sessions, files and commands                 |
| **⌘B**             | Show or hide the sidebar                            |
| **⌘⌥B**            | Show or hide the right panel                        |
| **⌘J**             | Collapse or expand the terminal dock                |
| **⌘`**             | Focus the terminal                                  |
| **⌘⇧G**            | Open the Changes tab                                |
| **⌘S**             | Save the open file                                  |
| **⌃O**             | Expand or collapse tool calls                       |
| **⌘,**             | Open settings                                       |
| **⌘+** / **⌘−**    | Code size, in a terminal                            |
| **Enter**          | Send the prompt                                     |
| **Shift+Enter**    | New line in the prompt                              |
| **Escape**         | Stop the agent while it is working                  |
| **⌘Enter**         | Commit, in the Changes tab; post, in a diff comment |
| **/** then **Tab** | Complete a command in the composer                  |
| **Enter**          | Allow, or submit an answer, on a focused card       |
| **⌘Enter**         | Always allow, on a focused permission card          |
| **Escape**         | Deny, on a focused permission card                  |
| **1** to **9**     | Pick an option, on a focused question card          |

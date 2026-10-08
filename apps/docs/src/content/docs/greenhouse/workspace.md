---
title: The workspace
description: The Greenhouse IDE, the shared chat thread, the editor, the review panel, the terminal dock and the keyboard shortcuts.
sidebar:
  order: 4
---

Opening a machine opens its workspace: a full-height IDE with four regions.

| Region            | What it holds                                                                       |
| ----------------- | ----------------------------------------------------------------------------------- |
| **Sidebar**       | The machine switcher, navigation, and every session grouped by repository.          |
| **Centre**        | The session's tabs: its chats, open files, diffs and previews.                      |
| **Right panel**   | Files, changes, checks and review comments for the session, over the terminal dock. |
| **Terminal dock** | Setup and run script output, terminals and listening ports.                         |

Every split is resizable by dragging or with the keyboard, and the sizes are
remembered. Below 960 pixels wide the workspace becomes a single column for
reviewing on a phone: sessions, transcript and changes, without the editor or
terminals.

## Sidebar

- **Machine switcher.** The current machine with its status. The menu switches
  machines, starts or stops this one, opens machine settings and sharing, and
  creates a new machine.
- **Home.** The launch composer and your recent sessions across machines,
  including machines shared with you.
- **New session** (**⌘N**) and **Search** (**⌘K**).
- **Repositories.** One group per repository cloned on the machine, with a **+**
  to start a session in it. **Add repository** clones another one.
- **Sessions.** Each row shows what the agent is doing, the title, the diffstat
  against the base branch (`+42 −7`) and who else is looking at it. Archived
  sessions collapse under **Archived**.
- **Footer.** The runner and, on hover, how long until the idle stop.

A session's status glyph tells you whether the agent is **working**, **waiting
for you**, idle, or whether the work is **done** (its pull request merged). A
pencil means you have an unsent draft in its composer.

Right-click a session (or use its menu) to rename it, copy its branch name, open
its pull request, archive it, or delete it with or without its branch.

## Centre

The top bar shows `repo › branch`. The branch menu copies the branch name or the
worktree path. The session menu (**⋯**) holds:

- **Rename** and **Archive**.
- **Fork session.** A new session branched from this one's branch, for trying a
  different approach from the same point.
- **Copy share link** and **Share machine**. See [Sharing](/greenhouse/sharing/).
- **Deploy preview.** See [Previews](/greenhouse/previews/#deploy-a-session-as-a-preview-environment).

On the right of the top bar: the people here (click someone to follow them),
**Open in** for your editor, and the pull request button.

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

| Tab          | What it is                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Setup**    | The live output of the session's setup script. Read only.                                                                          |
| **Run**      | The output of the run script, with **Run** to start it and a stop button. See [Setup and run scripts](/greenhouse/scripts/).       |
| **Terminal** | A shell in the session's worktree. **+** opens another; **⌘`** jumps to the terminal.                                              |
| **Ports**    | Every port a process on the machine is listening on, with which process, whether it belongs to this session, and **Open preview**. |

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
| **Enter**          | Send the prompt                                     |
| **Shift+Enter**    | New line in the prompt                              |
| **Escape**         | Stop the agent while it is working                  |
| **⌘Enter**         | Commit, in the Changes tab; post, in a diff comment |
| **/** then **Tab** | Complete a command in the composer                  |

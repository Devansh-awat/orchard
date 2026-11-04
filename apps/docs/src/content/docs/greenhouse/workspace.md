---
title: Workspace
description: Review the layout, settings, chat controls, slash commands, right panel, terminal dock, and keyboard shortcuts of the Greenhouse workspace.
sidebar:
  order: 4
---

The workspace opens when you open a machine. It has a title bar, a sidebar, a center area, a right panel, and a terminal dock.

## Layout

| Region        | Contents                                                                            |
| ------------- | ----------------------------------------------------------------------------------- |
| Title bar     | Back and forward, the current location, people on the machine, and session actions. |
| Sidebar       | The machine menu, search, the home page, and sessions grouped by repository.        |
| Center        | Tabs for chats, open files, diffs, and previews.                                    |
| Right panel   | Tabs for files, changes, checks, and review comments.                               |
| Terminal dock | Setup and run output, terminals, and listening ports.                               |

Below 960 pixels wide, the workspace uses a single-column layout for mobile devices.

## Title bar

The location reads machine, repository, session. Select the machine name to go to the home page.

Select the session title to open the session menu:

| Item                 | Action                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Rename               | Renames the session.                                                                           |
| Copy branch name     | Copies the session's branch name.                                                              |
| Copy worktree path   | Copies the path of the session's worktree.                                                     |
| Copy link for guests | Copies a link to the session for people on the machine.                                        |
| Fork session         | Creates a session branched from this session's branch.                                         |
| Deploy preview       | Refer to [Preview a session](/greenhouse/previews/#deploy-a-session-as-a-preview-environment). |
| Archive              | Removes the worktree and keeps the branch.                                                     |
| Delete               | Removes the session, with or without its branch.                                               |

The right side of the title bar has the avatars of other people on the machine, the [editor button](/greenhouse/editors/), the [pull request button](/greenhouse/pull-requests/), **Share**, and the right panel toggle. Guests see **People** instead of **Share**. Select an avatar to follow that person.

## Sidebar

- **Machine menu:** Switches machines, shows CPU, memory, and disk use, starts or stops the machine, and opens **Machine settings**, **Fork machine**, and **New machine**.
- **Search:** Finds sessions, files, and commands.
- **Home:** Opens the prompt for new sessions, your recent sessions, and your machines.
- **New session:** Starts a session in the current repository.
- **Repositories:** Lists each repository with its sessions. Select **+** to start a session in it. Open the **...** menu to start a session, change the icon, or remove the repository.
- **Add repository:** Clones a repository, creates a new one, or opens a folder. Host only.
- **Archived:** Lists archived sessions.

A session row shows the agent's state, the title, the branch, and the diffstat against the base branch. Open the **...** menu on a row to rename the session, copy its branch name, open its pull request, archive it, or delete it.

A repository icon is stored in the repository's git config as `orchard.icon`. Everyone on the machine sees the same icon.

## Settings

Select the gear icon in the sidebar, or press `CMD + ,`.

| Group   | Section      | Contents                                                                                                                                                      |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine | Machine      | Name, SSH key, people, [setup script](/greenhouse/machines/#setup-script), [attached projects](/greenhouse/projects/), and machine deletion.                  |
| Machine | Usage        | CPU, memory, disk, and time limits.                                                                                                                           |
| You     | Preferences  | **Send messages with**, **Follow-up behavior**, **Auto-accept permissions**, **Agent notifications**, and transcript options such as **Show reasoning**.      |
| You     | Sounds       | The sound for each agent event.                                                                                                                               |
| You     | Appearance   | Theme, zoom, text sizes, and fonts.                                                                                                                           |
| You     | Git          | **Branch name prefix** and **Delete branch on archive**.                                                                                                      |
| You     | Agents       | The coding agents on this machine, their sign-in state, and Claude usage limits. Requires a running machine.                                                  |
| You     | Context      | Your `CLAUDE.md`, subagents, slash commands, skills, and MCP servers. To import them from Claude Code, run [`orchard claude import`](/reference/cli/#claude). |
| You     | Integrations | Your [GitHub, Linear, and Slack accounts](/greenhouse/integrations/#link-your-accounts).                                                                      |
| You     | Shortcuts    | Every keyboard shortcut and command.                                                                                                                          |

Greenhouse saves **Preferences**, **Appearance**, and **Git** on the current device.

**Remove flattery** removes flattery from agent replies in your view. The stored transcript does not change.

## Chat

Each chat is one thread that everyone in the session can see.

- Plain text is a prompt to the agent. The thread shows who sent it.
- `/chat <message>` is a comment to the people in the session. The agent does not see it.

Select **+** in the tab strip to start another chat in the same worktree. **Checkpoints** lists the prompts of the current chat. Select a prompt to undo everything the agent did after it.

The thread collapses the steps of a turn into one activity row. Expand the row to see each step.

### Permission and question cards

When the agent needs a decision, it waits and a card appears above the composer.

| Card       | Actions                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission | **Allow** approves this request. **Always allow** stops asking for this kind of request. **Deny** refuses it. You can tell the agent what to do instead. |
| Question   | Select an option, or enter your own answer. **Skip** dismisses the question.                                                                             |
| Plan       | **Start building** leaves plan mode. **Keep planning** stays in plan mode. You can also send feedback.                                                   |

Read-only guests see the cards but cannot answer them.

**Auto-accept permissions** allows permission requests automatically in chats where you sent the last prompt. Questions still wait for an answer.

### Composer

- **Attach files or images** adds up to 10 files of up to 5 MB each. You can also drop files on the composer.
- The model menu selects the model, the effort, and the agent for the next prompt.
- Plan mode runs the agent read-only, so that it proposes a plan without editing files.
- The ring shows how much of the model's context the chat has used.

If you send a prompt while the agent is working, the prompt waits in a queue by default. Queued prompts go out one at a time. To interrupt the agent instead, change **Follow-up behavior** to steer.

### Slash commands

Type `/` in the composer to list commands. Built-in commands act on Greenhouse. `/init`, `/review`, and `/security-review` send the agent a prepared prompt.

| Command                       | Action                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `/help`                       | Lists every command.                                               |
| `/clear`, `/new`              | Starts a new chat in a new tab.                                    |
| `/compact`                    | Summarizes the chat to free up context.                            |
| `/resume`, `/continue`        | Switches to another chat.                                          |
| `/rename <title>`             | Renames the session.                                               |
| `/export`                     | Downloads the chat as Markdown.                                    |
| `/undo`, `/rewind`            | Rolls back the last prompt and its changes.                        |
| `/redo`                       | Restores what `/undo` rolled back.                                 |
| `/todos`                      | Shows the agent's todo list.                                       |
| `/stop`                       | Stops the agent.                                                   |
| `/chat <message>`             | Messages the people in the session.                                |
| `/model`                      | Selects the model.                                                 |
| `/effort`                     | Sets the reasoning effort.                                         |
| `/fast`                       | Turns fast mode on or off.                                         |
| `/plan`, `/build`             | Enters or leaves plan mode.                                        |
| `/agents`                     | Selects the agent that answers.                                    |
| `/init`                       | Writes an `AGENTS.md` for the repository.                          |
| `/review`                     | Reviews uncommitted changes, or a commit, branch, or pull request. |
| `/security-review`            | Reviews the branch for security issues.                            |
| `/context`, `/cost`, `/usage` | Shows context used, cost, and Claude usage limits.                 |
| `/mcp`                        | Manages MCP servers.                                               |
| `/memory`                     | Edits `AGENTS.md` or `CLAUDE.md`.                                  |
| `/permissions`                | Opens permission settings.                                         |
| `/terminal`                   | Opens a terminal.                                                  |
| `/diff`                       | Opens **Changes**.                                                 |
| `/pr`                         | Creates or opens the pull request.                                 |
| `/status`                     | Shows machine and branch status.                                   |
| `/share`                      | Opens the share sheet.                                             |
| `/settings`, `/config`        | Opens settings.                                                    |
| `/bug`, `/feedback`           | Opens a new issue on the Orchard repository.                       |

Commands that the agent server reports for the repository, such as skills and MCP prompts, appear under **Repository**.

## Editor

Files open in the Monaco editor. Files up to 500 KB can be edited in the browser. To edit a larger file, connect [an editor over SSH](/greenhouse/editors/).

When two people open the same file, they edit it together and see each other's cursors. Edits that the agent makes on disk merge into the open file.

### Diffs and review comments

Select a changed file to open its diff. Select a line number to comment on that line. Comments appear in the **Review** tab of the right panel, grouped by file.

**Send review to agent** combines all comments into one prompt and queues it.

## Right panel

| Tab       | Contents                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| All files | The worktree as a tree. Right-click to create, rename, or delete files and folders.                                          |
| Changes   | Changed files with line counts, and a commit box. Refer to [Commit, push, and merge](/greenhouse/pull-requests/).            |
| Checks    | The pull request's state, its checks, and **Fix with agent**. Refer to [Checks](/greenhouse/pull-requests/#3-review-checks). |
| Review    | Your diff comments.                                                                                                          |

## Terminal dock

| Tab      | Contents                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup    | Output of the session's setup script. Read-only.                                                                                                                                      |
| Run      | Output of the run script, with start and stop controls. A repository with several commands has one tab per command. Refer to [Configure setup and run scripts](/greenhouse/scripts/). |
| Terminal | A shell in the session's worktree. Select **+** to open another.                                                                                                                      |
| Ports    | Ports that processes on the machine listen on. Refer to [Preview a session](/greenhouse/previews/).                                                                                   |

Terminals run inside `tmux` on the machine. They survive a page reload or a dropped connection.

Each person has their own terminals, with their own git identity and GitHub credential. You can watch another person's terminal, but you can type only in your own. **Setup** and **Run** are the same for everyone in the session.

## Keyboard shortcuts

On Windows and Linux, use `CTRL` for `CMD`, and `ALT` for `OPT`.

| Shortcut                        | Action                                      |
| ------------------------------- | ------------------------------------------- |
| `CMD + N`                       | New session in the current repository       |
| `CMD + K`                       | Search sessions, files, and commands        |
| `CMD + B`                       | Show or hide the sidebar                    |
| `CMD + OPT + B`                 | Show or hide the right panel                |
| `CMD + SHIFT + G`               | Open the **Changes** tab                    |
| `CMD + ,`                       | Open settings                               |
| `ENTER`                         | Send the prompt                             |
| `SHIFT + ENTER`                 | New line in the prompt                      |
| `CMD + ENTER`                   | Steer instead of queueing                   |
| `ESC`                           | Stop the agent while it is working          |
| `/`, `TAB`                      | Complete a command                          |
| `CTRL + O`                      | Expand or collapse tool calls               |
| `CMD + SHIFT + E`               | Fast mode, when the model has one           |
| `CMD + SHIFT + /`               | Cycle reasoning effort                      |
| `CMD + P`                       | Find a file                                 |
| `CMD + S`                       | Save the open file                          |
| `CMD + F`                       | Find in the file                            |
| `` CMD + ` ``                   | Focus the terminal                          |
| `CMD + J`                       | Collapse or expand the dock                 |
| `CMD + +`, `CMD + −`, `CMD + 0` | Change or reset the code size in a terminal |

On a focused permission or question card:

| Shortcut      | Action                           |
| ------------- | -------------------------------- |
| `ENTER`       | Allow, or submit the answer      |
| `CMD + ENTER` | Always allow                     |
| `ESC`         | Deny, then press `ENTER` to send |
| `1` to `9`    | Select an option                 |

In the **Changes** tab and in diff comments, `CMD + ENTER` commits or posts.

The **Send messages with** preference changes the send and new-line keys. **Settings** > **Shortcuts** shows the current keys.

## Related resources

- [Get started](/greenhouse/getting-started/)
- [Machines](/greenhouse/machines/)
- [Share a machine](/greenhouse/sharing/)
- [Keyboard shortcuts and search](/account/command-palette/)

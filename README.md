# Tab Manager

One editor **layout per worktree**. In a parent/hub window, the **Tab Manager**
activity bar icon holds a single **Layouts** section; windows opened at a child
worktree get a dedicated **Worktree** icon with a Pull Request view and a
changed-files view instead (see below).

```
▾ LAYOUTS
  ▾ tab-manager                    ← repository (collapsible)
      trenton        ●             ← worktree, holds one layout (● = active)
      velvety
  ▾ other-repo
      main           no layout
```

**Clicking a worktree opens it in a new VS Code window rooted at its folder.**
To swap arrangements inside the current window instead, right-click →
**Switch to Worktree Layout**: it restores how the editor was split into panes
and what was open in each pane (files and editor-area terminals), auto-saving
your current arrangement back to the worktree you were on.

## Usage

1. Open a repo (or several). Worktrees of the same repo group under one
   collapsible section; multiple repos each get their own. Beyond the folders
   you've explicitly opened, any worktree living under an open repo's
   `.claude/worktrees/<name>/` is auto-discovered and listed too — no need to
   add each one to the workspace by hand. Discovered worktrees are marked
   **not open**; clicking one opens/saves its files by path without adding it
   to the VS Code workspace.
2. Click a worktree in the **Tab Manager** view to make it active, and arrange
   your editor however you like.
3. Click another worktree to switch: your arrangement is auto-saved to the
   worktree you're leaving, and the clicked worktree's layout loads. A worktree
   without a saved layout starts **blank** (no panes) rather than keeping
   whatever was open before — arrange it and switch away to save it.

Hover a **repo** section for the **＋** icon: it creates a new worktree for
that repo under `.claude/worktrees/<name>`, on a new branch of the same name,
and it appears in the list immediately.

Hover a worktree for the **copy** icon (copy its absolute path), the **×**
icon (clear its saved layout) and, on worktrees not open in the workspace, the
**trash** icon (**delete the worktree** — directory and all, via `git worktree
remove`; modal-confirmed, with an explicit force step if the worktree has
uncommitted changes). Force-saving the current arrangement into the active
worktree is available from the command palette ("Tab Manager: Save Current
Arrangement to Active Worktree"); switching auto-saves anyway.

A worktree linked to a PR (right-click → **Link with PR...**) displays the
**PR's title** as its row label; the folder name and PR number stay in the
tooltip. The title re-syncs whenever the PR view fetches it or you rename the
PR from there.

## Pull Request

Right-click a worktree in **Layouts** → **Link with PR...** to associate it
with a pull request (pick from the repo's open PRs, or type a number; the same
menu unlinks); the row then displays the PR's title. The **Pull Request**
view — shown in child worktree windows — displays that worktree's PR (the
linked one, or failing that the current branch's, looked up with the GitHub
CLI `gh`) with a large title and is an editing surface:

- **Rename PR...** — change the title in an input box.
- **Edit description...** — opens the PR body as a markdown file; every save
  (⌘S) publishes it back to the PR.

Clicking the PR row itself opens it on GitHub; with no PR, a row links to
GitHub's compare page. Refresh with the title-bar button after pushing.

Terminals stay alive across switches: when you leave a worktree its editor-area
terminals are tucked into the bottom panel (still running) and pulled back when
you return, so long-running processes survive. The **Tab Manager: Hide Panel On
Switch** setting (Settings UI, or `tabManager.hidePanelOnSwitch`) controls
whether the panel is collapsed after each switch (on by default). This is
best-effort — VS Code has no API to move a terminal into a specific pane, so a
terminal can occasionally land in the wrong pane, and terminals sharing a name
can be mixed up. Preservation lasts for the current VS Code session; after a
window reload terminals reopen as fresh shells.

Layouts are stored per-workspace (they reference this workspace's files).

## Child worktree windows

A window opened at a linked worktree (e.g. via clicking a worktree row, which
opens `.claude/worktrees/<name>` in its own window) shows a dedicated
**Worktree** activity-bar icon instead of the regular Tab Manager one. Its
container holds just two sections: the worktree's **Pull Request** (same
rename/edit-description tooling) and **Changed Files** — the file tree with
the diff filter locked on, comparing against your picked branch or, failing
that, the repo's default branch (`origin/HEAD`); the title-bar branch button
changes the base. Parent/hub windows keep the regular container.

## Run

1. `npm install`
2. `npm start` — compiles and launches the Extension Development Host
3. Click the Tab Manager icon in the activity bar to open the view

## Test

`npm test` launches a real VS Code (downloaded to `.vscode-test/` on first
run) and drives the terminal keep-alive scenario end to end: park, revive,
same-process checks, busy terminals, multi-terminal layouts. A window will
briefly open. The extension also logs each park/revive step to
**Output → Tab Manager** for debugging.

# Tab Manager

One editor **layout per worktree**. The **Tab Manager** activity bar icon opens
two sections — **Layouts** and **Files** — each its own native collapsible view,
the same way the built-in Explorer stacks Outline/Timeline/Dependencies.

```
▾ LAYOUTS
  ▾ tab-manager                    ← repository (collapsible)
      trenton        ●             ← worktree, holds one layout (● = active)
      velvety
  ▾ other-repo
      main           no layout
▾ FILES                trenton     ← files of the active worktree only
    src
    package.json
```

Clicking a worktree in **Layouts** restores its layout — how the editor was
split into panes and what was open in each pane (files and editor-area
terminals). Arrange freely, click another worktree, and your arrangement is
saved back to the worktree you were on.

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
menu unlinks). The **Pull Request** view shows the active worktree's PR — the
linked one, or failing that the current branch's, looked up with the GitHub
CLI (`gh`) — and is an editing surface:

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

## Files

The **Files** view shows only the active worktree's file tree — unlike the
built-in Explorer, which shows every open worktree at once with no way to scope
it to one (VS Code has no such filter). Its header names the active worktree;
until you've clicked one in **Layouts**, it shows a prompt to do so. Click a
file to open it; folders expand in place. Rows are colored by the built-in Git
extension: green for additions, orange for modifications, dimmed for gitignored
files — the same colors and logic VS Code already uses elsewhere, so nothing
here is hand-rolled or can drift from your actual git status. The one
trade-off: getting that coloring requires each row to carry a `resourceUri`,
and VS Code always pairs that with a small file-type icon — there's no
supported way to get colored text without it (a
[longstanding open VS Code limitation](https://github.com/microsoft/vscode/issues/54281)).

A checkbox row at the top — **Only files changed vs \<branch\>** — filters the
tree down to files that differ from a branch of your choice (what a PR against
it would contain: committed changes since the merge-base, plus uncommitted and
untracked files). Folders show only while they contain changed files. Click
the row's label to pick the branch (e.g. `staging`); the choice is remembered
per workspace, and the list refreshes as you edit, stage, or commit.

While the filter is on, clicking a file opens it as a **diff** against the
compare branch's merge-base (files that didn't exist there diff against empty
content — an all-added view). With the filter off, clicking opens the file
normally.

Right-clicking gives the usual Explorer-style menu. On a folder: New File...,
New Folder..., Reveal in Finder, Cut, Copy, Paste, Copy Path, Copy Relative
Path, Rename..., Delete. On a file: Open to the Side, Open With..., Reveal in
Finder, plus the same clipboard/path/rename/delete actions. Delete moves to
the Trash; Copy Relative Path is relative to the active worktree's root;
pasting over an existing name creates "name copy" like the Explorer does.

A worktree living under a gitignored path (e.g. `.claude/worktrees/<name>`,
gitignored in the parent repo) would otherwise have every one of its files
shown as ignored — the Git extension's own auto-detection skips scanning
inside ignored directories ([microsoft/vscode#41565](https://github.com/microsoft/vscode/issues/41565)),
so it never learns the worktree is its own repository. Whenever a worktree
becomes active, this extension explicitly asks the Git extension to open it as
its own repository, so ignore/modified status is computed against *its own*
root and `.gitignore`, not the parent's.

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

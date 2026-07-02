# Tab Manager

Worktree-centric **window management** for parallel work on many PRs. A hub
window lists every repo's worktrees; each worktree opens in its own VS Code
window, with its pull request and changed files in the sidebar.

```
▾ WORKTREES                          (hub window)
  ▾ aegis-core                       ← repository, ＋ to add a worktree
      aegis-core
      feat(evals): pp-isol — …       ← linked worktrees show their PR title
      646
  ▾ portfolio
      portfolio
```

## Hub window

- **Click a worktree** → opens it in a new window rooted at its folder.
- **＋ on a repo** → **Create New Worktree...** (name → branch of the same
  name under `.claude/worktrees/<name>`) or **Create From PR...** (search the
  repo's open PRs; creates `.claude/worktrees/<number>` with the PR's branch
  checked out via `gh pr checkout`, pre-linked so the row shows the PR title).
- **Hover a worktree** → copy its absolute path, or delete it (`git worktree
  remove`, modal-confirmed, explicit force step for dirty trees; only offered
  when the folder isn't open in the workspace).
- **Right-click** → **Link with PR...** to associate the worktree with a pull
  request (or unlink); linked rows display the PR's title.

Worktrees under an open repo's `.claude/worktrees/` are discovered
automatically — no need to add them to the workspace.

## Worktree windows

A window opened at a `.claude/worktrees/<name>` folder shows a dedicated
**Worktree** activity-bar container instead of the hub one:

- **Pull Request** — the worktree's PR (linked, or detected from the branch)
  with a large title. **Rename...** edits the title; **Edit description...**
  opens the body as markdown where every save (⌘S) publishes back to the PR;
  no PR yet offers **Link to PR...** and **Create PR on GitHub...**.
- **Changed Files** — only files that differ from the compare branch (your
  pick via the title-bar branch button, else the repo's default branch), with
  git-status coloring. Clicking a changed file opens it as a diff against the
  merge-base. Explorer-style context menus (new file/folder, reveal,
  cut/copy/paste, copy path, rename, delete) included.

Requires the GitHub CLI (`gh`, signed in) for all PR features.

## Install / develop

1. `npm install`
2. `npm start` — launches the Extension Development Host for hacking
3. `npm run package` → `code --install-extension tab-manager-<version>.vsix`
   to (re)install into your real VS Code (bump `version` first)

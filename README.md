# Tab Manager

Save and switch between editor **layouts** from the sidebar. A layout captures how
your editor is split into panes *and* what's open in each pane — files and
editor-area terminals — so you can keep, say, a "review" layout with a diff
side-by-side and a "coding" layout with a 2×2 grid plus a terminal, and jump
between them with one click.

Terminals stay alive across switches: when you leave a layout its terminals are
tucked into the bottom panel (still running) and pulled back when you return, so
long-running processes survive. The panel is collapsed after each switch so those
parked terminals stay hidden. This is best-effort — VS Code has no API to move
a terminal into a specific pane, so a terminal can occasionally land in the wrong
pane, and terminals sharing a name can be mixed up. Preservation lasts for the
current VS Code session; after a window reload terminals reopen as fresh shells.

## Usage

1. Arrange your editor however you like (split panes, open files).
2. Open the **Tab Manager** view in the activity bar and click **＋** to save the
   arrangement as a new layout (`Layout 1`, `Layout 2`, …).
3. Click any layout to load it. Hover a layout for icons to **update** it from the
   current arrangement, **rename**, or **delete** it.

Switching is **auto-save & swap**: when you click a different layout, your current
arrangement is first saved back into the active layout, then the clicked one
loads — so every layout remembers its own arrangement as you click between them.

Layouts are stored per-workspace (they reference this project's files).

## Run

1. `npm install`
2. `npm start` — compiles and launches the Extension Development Host
3. Click the Tab Manager icon in the activity bar to open the view

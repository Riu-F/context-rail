# Context rail

A pane beside the chat in Claude Code and the Claude desktop app that shows what the session holds and what it costs.

- **Cost:** the session total, each turn's cost and time, and the last turn's tokens (new input, cache reads and writes, output).
- **Plan limits:** the 5-hour and weekly limits as bars, with when each resets.
- **Context:** how full the context window is, as a bar coloured by what fills it, with the Obsidian vault's notes as their own part and share. Open it to see each part.
- **Folders:** the session's folders. Hover for the path, click to open it in Finder. If the Obsidian vault is neither added nor read, it shows here in orange as not added.
- **Obsidian vault:** which files from `~/Desktop/claude-context` the session has read, grouped by folder, with each folder's share of the tokens read. Files and folders the latest turn used are drawn bright, the rest dim. The vault shows in yellow until it is loaded.

Above the vault list are five views, picked with the icon buttons over them (hover any item in a chart for its name): Map, Share (a donut by folder), Timeline (each turn's notes stacked), Treemap (notes as rectangles by size) and Gaps (notes linked to what was loaded but not loaded). The Map is a graph of the notes the session read. Each sits in its area's slice of the circle at a spot fixed by its path, so the graph keeps its shape. Size is tokens loaded, colour is area, and the latest turn is bright. Lines are the `[[links]]` between loaded notes, and small faint dots are notes linked to them that were not loaded. Hover a note for its name and size; click a file in the list below to ring it in the graph and show its links.

Under each reply it adds a line with that turn's cost and the vault files it used. `/context-rail` opens the pane if it was closed; a bar above the prompt offers the same when you close it.

## Install

Clone the repository, add the folder as a marketplace, and install the mod for every session. Installed this way, the mod runs straight from the folder, so a `git pull` and `/reload-plugins` in a chat is all an update needs.

```bash
git clone https://github.com/Riu-F/context-rail.git ~/.claude/mods/context-rail
claude plugin marketplace add ~/.claude/mods/context-rail
claude plugin install context-rail@context-rail --scope user
```

If `claude` is not on your PATH, use the copy inside the desktop app:
`"$HOME/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app/Contents/MacOS/claude"`.

Start a new chat and the pane opens by itself.

## Develop

Edit the files, then run `/reload-plugins` in a chat. Check a change with:

```bash
claude plugin validate .
claude plugin test .
```

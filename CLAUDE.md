# Context rail: notes for Claude

You are probably here because someone asked you to install this mod, or to make it work with their Obsidian vault. This file says how the mod finds and draws a vault, what to check for a new vault, and what to change if their vault is set up differently.

## What the mod does

A pane beside the chat (`hooks/register.tsx`) with five sections: the session's folders, how full the context is, the Obsidian vault notes the session has read, plan limits, and cost. The vault section draws one of five charts (`hooks/graph.ts`): Map, Share, Timeline, Treemap and Gaps. Read `README.md` for what each shows.

## Installing it for someone

1. Clone the repository somewhere they keep code, for example `~/.claude/mods/context-rail`.
2. `claude plugin marketplace add <that folder>`, then `claude plugin install context-rail@context-rail --scope user`. In the desktop app `claude` may not be on the PATH; the CLI is inside the app at `~/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app/Contents/MacOS/claude`.
3. Ask for their vault's folder and set it (next section), or leave it to be found.
4. In a new chat, read a few of their notes and look at the pane with them.

## How the mod finds the vault

In this order:

1. **The `vaultPath` setting**, a full path or one starting with `~/`. Set it in the user's settings under `pluginConfigs`, keyed by the plugin (`"context-rail@context-rail": { "options": { "vaultPath": "~/Documents/Brain" } }`), or in a terminal's `/config`. Ask before editing their settings.
2. **Found:** the first path the session uses (its working folder, an added folder, an @-mention, a file it reads or a shell command) that sits inside a folder holding `.obsidian`. That folder is the vault for the rest of the session.

Until a vault is known, Folders shows "No Obsidian vault in this session" in orange. Once it is set but neither added nor read, it shows "Obsidian vault not added".

## How it reads the vault

- **Notes:** every `.md` file, except in hidden folders (`.`), folders starting with `_`, and whatever the vault's own `.obsidian/app.json` (`userIgnoreFilters`) and `.obsidian/templates.json` (`folder`) leave out.
- **Links:** `[[note name]]` links, matched by note name as Obsidian does. Where two notes share a name, the one nearer the root wins.
- **Colours:** the vault's Obsidian graph colour groups in `.obsidian/graph.json`. Only `path:` and `file:` terms joined by `OR` are read; a group using tags or `AND` is skipped. A note no group matches takes a palette colour picked from its top folder's name.
- **Layout:** each top folder gets a slice of the Map's circle, sized by how many notes it holds. The vault list and the Share chart group notes by their top folder, or their top two folders when they are two or more folders deep.
- **Tokens:** about four characters a token, from the size of what was read.

## After a chat restarts

The pane's state lives as long as the session's process. When the app stops an idle chat and starts it again, `rebuildSession` restores it: vault reads and added folders from the chat's transcript (`<config>/projects/<project>/<session id>.jsonl`), and each turn's cost from the mod's store (`turns:<session id>`, the last 40 sessions kept). It runs only when the pane's memory is empty, and decodes only the transcript lines that can hold a prompt, a tool call or result, or a folder.

## Checking a new vault

Look at the vault before changing any code:

- **Mostly loose notes at the root:** everything lands in one slice and one group. It works, but the Map says little. Grouping by something else (a tag, a frontmatter field) would need `groupOf` and `areaOf` changed to read it.
- **No colour groups in Obsidian:** palette colours are used. If they want their own, the easiest fix is to add colour groups in Obsidian's graph settings, not in this code.
- **Colour groups that use tags:** those groups are skipped. Supporting `tag:` means reading each note's tags in `buildIndex` and matching them in `noteColor`.
- **Links written as Markdown links** (`[text](note.md)`), not wikilinks: extend `linksIn` in `hooks/graph.ts`.
- **System folders not starting with `_`** (attachments, templates): add them to Obsidian's excluded files, which the mod reads, before touching the code.

## After any change

Run the tests and the checks, and add a test for the vault shape you adapted to:

```bash
claude plugin validate .
claude plugin test .
```

Tests in `tests/context-rail.test.tsx` fake the vault with `fs.list`, `fs.read` and `fs.exists`. Copy one and change the fake vault.

## Drawing rules

The charts are SVG images drawn at one design width (360 units) and sized to the pane's width, so they grow when the rail is widened. Text inside them is a data surface, so it can sit below the 16 pixel floor used for the rest of the pane. Hover labels use CSS `:hover` inside the image; the pane draws images with `isInteractive`, which allows it.

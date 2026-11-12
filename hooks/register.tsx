import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextFill, Limit, ReadKind, Totals, Turn, VaultRead } from '../types'
import { gaps, graphSvg, lighten, linksIn, noteColor, noteName, parseColorGroups, setColorRules, shareSvg, timelineSvg, treemapSvg } from './graph'
import type { GraphNode, VaultIndex } from './graph'

const PANE = 'context-rail'
const TITLE = 'Session'

// The vault every session should have. Matched anywhere in a path, so it
// holds on any machine where the vault sits on the Desktop.
const VAULT_NAME = 'Obsidian vault'

// The vault this session tracks: the vaultPath setting, or the first folder
// the session uses that sits inside a vault (a folder holding `.obsidian`).
let vaultRootPath: string | null = null
let vaultMatcher: RegExp | null = null
let homeDir = ''
// The vaultPath setting, as the module was loaded with it.
let configuredVault = ''

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Sets the vault and the pattern that finds its paths in any text. */
function setVaultRoot(root: string | null) {
  vaultRootPath = root ? root.replace(/\/+$/, '') : null
  if (!vaultRootPath) {
    vaultMatcher = null
    return
  }
  const forms = [escapeRegExp(vaultRootPath)]
  if (homeDir && vaultRootPath.startsWith(`${homeDir}/`)) {
    forms.push(`~${escapeRegExp(vaultRootPath.slice(homeDir.length))}`)
  }
  // The vault's path, then either the end of the path or a path inside it.
  vaultMatcher = new RegExp(`(?:${forms.join('|')})(?=$|[/\\s"'\`;|&)<>])(/[^\\s"'\`;|&)<>]*)?`, 'g')
}

// Change a shape tag when that value's fields change: it declines what an
// earlier version stored, which outlives a reload.
const turns = atom({ plugin: 'context-rail', key: 'turns' } as const, [], {
  shape: 'turns-1',
})
const totals = atom(
  { plugin: 'context-rail', key: 'totals' } as const,
  { limits: [], checkedAt: 0 },
  { shape: 'totals-2' },
)
const reads = atom({ plugin: 'context-rail', key: 'reads' } as const, [], {
  shape: 'reads-1',
})
const folders = atom({ plugin: 'context-rail', key: 'folders' } as const, [])
const open = atom({ plugin: 'context-rail', key: 'open' } as const, [], {
  shape: 'open-2',
})
// The note picked in the vault list, ringed in the graph.
const focus = atom({ plugin: 'context-rail', key: 'focus' } as const, null)
// Bumped when the vault index is built, so the pane redraws with the links.
// The vault found this session, kept across reloads of the mod.
const knownVault = atom({ plugin: 'context-rail', key: 'knownVault' } as const, null)

// Which drawing the vault section shows.
const view = atom({ plugin: 'context-rail', key: 'view' } as const, 'map')
// Buttons hold text, so each view's icon is a symbol of the system font.
const VIEWS = [
  { id: 'map', label: 'Map', icon: '⛬' },
  { id: 'share', label: 'Share', icon: '◔' },
  { id: 'timeline', label: 'Timeline', icon: 'ılı' },
  { id: 'treemap', label: 'Treemap', icon: '◫' },
  { id: 'gaps', label: 'Gaps', icon: '⬚' },
] as const
const indexStamp = atom({ plugin: 'context-rail', key: 'indexStamp' } as const, 0)

// The vault's notes and links, read once per load of the mod.
let vaultIndex: VaultIndex | null = null
let isIndexing = false

const isPaneClosed = atom(
  { plugin: 'context-rail', key: 'isPaneClosed' } as const,
  false,
)

// Colours for the drawings: the context categories as the rail draws them.
const BLUE = '#4b8bf5'
const BLUE_DIM = '#4b8bf566'
const AMBER = '#e5a50a'
const PART_COLORS: Record<string, string> = {
  Messages: BLUE,
  'MCP tools': '#e0702e',
  'System tools': '#3aa883',
  'System prompt': AMBER,
  'Custom agents': '#b07cf0',
  [VAULT_NAME]: '#c084fc',
}
function partColor(name: string): string {
  return PART_COLORS[name] ?? '#9a9a9a'
}
const FOLDER_MISSING_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e5a50a" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><path d="M9.5 11l5 5M14.5 11l-5 5"/></svg>'
const FOLDER_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9a9a9a" stroke-width="1.8" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>'

// ---------------------------------------------------------------- formatting

// A turn's reply is matched to its cost by a hash of its text: the
// transcript's reply block carries no turn id.
function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return `${text.length}:${h >>> 0}`
}

function usd(value: number | undefined): string {
  if (value === undefined) return 'n/a'
  if (value < 0.01) return value === 0 ? '$0.00' : '<$0.01'
  return `$${value.toFixed(2)}`
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function seconds(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function cachedShare(t: Turn): number | undefined {
  const all = t.input + t.cacheRead + t.cacheWrite
  return all === 0 ? undefined : Math.round((t.cacheRead / all) * 100)
}

function limitName(kind: string): string {
  if (kind === 'five_hour') return '5-hour limit'
  if (kind === 'seven_day') return 'Weekly limit'
  if (kind === 'spend_limit') return 'Spend limit'
  return kind.replace(/_/g, ' ')
}

function resetsIn(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `Resets in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `Resets in ${hours}h ${mins % 60}m`
  return `Resets in ${Math.round(hours / 24)} days`
}

function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

/** A vault-relative path's file name without `.md`, for a compact list. */
function fileLabel(path: string): string {
  const name = path.replace(/\/$/, '').split('/').pop() ?? path
  if (name === '' || name === '.') return 'Vault root'
  return name.replace(/\.md$/, '')
}

function isFolder(path: string): boolean {
  return path.endsWith('/')
}

/** `base` and a relative path joined, `.` and `..` resolved; null outside the vault. */
function joinVault(base: string, rel: string): string | null {
  const out = base.split('/').filter(Boolean)
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
    } else {
      out.push(part)
    }
  }
  const joined = out.join('/')
  return rel.endsWith('/') ? `${joined}/` : joined
}

/**
 * The vault files a shell command names: full paths anywhere, and short
 * paths after a `cd` into the vault (or when the session runs inside it).
 * A short path counts when it names a file by its extension.
 */
function shellVaultPaths(command: string, cwdInVault: string | null): string[] {
  const found = new Set<string>()
  let base = cwdInVault
  let didEnterVault = false
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const words = (segment.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(w =>
      w.replace(/^["']|["']$/g, ''),
    )
    if (words[0] === 'cd') {
      const target = words[1] ?? ''
      const named = vaultPaths(target)[0]
      if (named !== undefined) {
        base = named === './' ? '' : named.replace(/\/$/, '')
        didEnterVault = true
      } else if (base !== null && !/^[/~$]/.test(target)) {
        base = joinVault(base, target)
      } else {
        base = null
      }
      continue
    }
    for (const p of vaultPaths(segment)) found.add(p)
    if (base === null) continue
    for (const word of words.slice(1)) {
      if (/^[-/~]|[$*?=(){}<>`]/.test(word)) continue
      if (!/\.[A-Za-z0-9]{1,6}$/.test(word)) continue
      if (/(^|\/)\.(git|obsidian)\//.test(word)) continue
      const path = joinVault(base, word)
      if (path) found.add(path)
    }
  }
  const files = [...found].filter(p => !isFolder(p))
  if (files.length > 0) return files
  // Nothing named: the command looked around the vault.
  if (found.size > 0) return [...found]
  return didEnterVault && base !== null ? [base === '' ? './' : `${base}/`] : []
}

/** The vault folder a path is grouped under in the chart. */
/** The area a vault folder group belongs to, for its colour. */
function areaOfGroup(group: string): string {
  return group === 'Vault root' ? 'root' : (group.split('/')[0] ?? 'root')
}

/**
 * The vault folder a note is grouped under: the vault's root, a top folder,
 * or, for a note two or more folders deep, its top two folders.
 */
function groupOf(path: string): string {
  const parts = path.split('/').filter(p => p !== '' && p !== '.')
  const depth = isFolder(path) ? parts.length : parts.length - 1
  if (depth <= 0) return 'Vault root'
  const [top, second] = parts
  if (depth >= 2 && second) return `${top}/${second}`
  return top ?? 'Vault root'
}

/** Every vault path named in a text, relative to the vault root. */
function vaultPaths(text: string): string[] {
  const found = new Set<string>()
  if (!vaultMatcher) return []
  for (const match of text.matchAll(vaultMatcher)) {
    const rest = (match[1] ?? '/').replace(/^\//, '')
    found.add(rest === '' ? './' : rest)
  }
  return [...found]
}

// ---------------------------------------------------------------- engine reads

async function refreshTotals($: EngineInterface): Promise<Totals> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const limits: Limit[] = usage.rateLimits.map(l => ({
    kind: l.kind,
    percentUsed: l.percentUsed,
    resetsAt: l.resetsAt,
  }))
  const parts = (usage.context.breakdown?.categories ?? [])
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind }))
    .sort((a, b) => b.tokens - a.tokens)
  const context: ContextFill = {
    tokens: usage.context.tokens,
    window: usage.context.window,
    percent: usage.context.percent,
    parts,
  }
  const next: Totals = {
    usd: usage.cost?.usd,
    limits,
    context,
    checkedAt: await $.clock.now(),
  }
  await update($, totals, () => next)

  // Vault instruction files that loaded on their own (a folder's CLAUDE.md).
  const loaded = (usage.context.breakdown?.memoryFiles ?? []).flatMap(f => vaultPaths(f.path))
  if (loaded.length > 0) {
    const seen = new Set((await read($, reads)).map(r => r.path))
    const fresh = loaded.filter(p => !seen.has(p))
    for (const path of fresh) {
      const file = usage.context.breakdown?.memoryFiles.find(f => vaultPaths(f.path)[0] === path)
      await noteVault($, [path], 'auto', (file?.tokens ?? 0) * 4)
    }
  }
  return next
}

// Folders already checked for `.obsidian`, so each is asked once.
const checkedForVault = new Set<string>()

/** The vault a path sits in: its nearest folder, or folder above, holding `.obsidian`. */
async function vaultAround($: EngineInterface, path: string): Promise<string | null> {
  const parts = path.replace(/^~(?=\/)/, homeDir).split('/')
  for (let n = parts.length; n > 1; n--) {
    const dir = parts.slice(0, n).join('/')
    if (!dir.startsWith('/') || checkedForVault.has(dir)) continue
    checkedForVault.add(dir)
    try {
      if (await $.fs.exists(`${dir}/.obsidian`)) return dir
    } catch {
      return null
    }
  }
  return null
}

/** Learns the home folder and applies the vaultPath setting, once. */
async function ensureVault($: EngineInterface) {
  if (!homeDir) homeDir = (await $.env.get('HOME')) ?? ''
  if (!vaultRootPath && configuredVault) {
    setVaultRoot(configuredVault.replace(/^~(?=\/|$)/, homeDir))
  }
}

/** Finds the vault from the paths in a text, while none is known yet. */
async function findVaultIn($: EngineInterface, text: string) {
  await ensureVault($)
  if (vaultRootPath) return
  for (const m of text.matchAll(/(?:~|\/)[^\s"'`;|&)<>]*/g)) {
    const found = await vaultAround($, m[0])
    if (found) {
      setVaultRoot(found)
      await update($, knownVault, () => found)
      return
    }
  }
}

/** The folders, below the vault, that the index leaves out. */
async function ignoredFolders($: EngineInterface, root: string): Promise<string[]> {
  const ignored: string[] = []
  try {
    const app = JSON.parse(await $.fs.read(`${root}/.obsidian/app.json`)) as { userIgnoreFilters?: string[] }
    ignored.push(...(app.userIgnoreFilters ?? []))
  } catch {
    // No ignore list.
  }
  try {
    const templates = JSON.parse(await $.fs.read(`${root}/.obsidian/templates.json`)) as { folder?: string }
    if (templates.folder) ignored.push(templates.folder)
  } catch {
    // No templates folder set.
  }
  return ignored.map(f => f.replace(/^\/+|\/+$/g, '')).filter(Boolean)
}

async function buildIndex($: EngineInterface, root: string) {
  if (vaultIndex || isIndexing) return
  isIndexing = true
  try {
    const notes: { path: string; text: string }[] = []
    const ignored = await ignoredFolders($, root)
    const walk = async (rel: string) => {
      const entries = await $.fs.list(rel ? `${root}/${rel}` : root)
      for (const entry of entries) {
        // Hidden folders, `_` system folders, and what the vault's own
        // settings tell Obsidian to leave out.
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
        const path = rel ? `${rel}/${entry.name}` : entry.name
        if (ignored.some(f => path === f || path.startsWith(`${f}/`))) continue
        if (entry.kind === 'dir') await walk(path)
        else if (entry.kind === 'file' && entry.name.endsWith('.md')) {
          notes.push({ path, text: await $.fs.read(`${root}/${path}`) })
        }
      }
    }
    await walk('')
    // The vault's own colours, as its Obsidian graph sets them.
    try {
      setColorRules(parseColorGroups(await $.fs.read(`${root}/.obsidian/graph.json`)))
    } catch {
      setColorRules([])
    }
    const byName = new Map<string, string>()
    const tokenCount = new Map<string, number>()
    for (const n of notes) {
      const name = (n.path.split('/').pop() ?? n.path).replace(/\.md$/, '').toLowerCase()
      // Two notes of one name (each folder's CLAUDE.md): the shallower wins.
      const held = byName.get(name)
      if (!held || held.split('/').length > n.path.split('/').length) byName.set(name, n.path)
      tokenCount.set(n.path, Math.round(n.text.length / 4))
    }
    const links = new Map<string, Set<string>>()
    const join = (a: string, b: string) => {
      if (a === b) return
      links.set(a, (links.get(a) ?? new Set()).add(b))
      links.set(b, (links.get(b) ?? new Set()).add(a))
    }
    for (const n of notes) {
      for (const name of linksIn(n.text)) {
        const target = byName.get(name)
        if (target) join(n.path, target)
      }
    }
    vaultIndex = { byName, tokens: tokenCount, links }
    await update($, indexStamp, n => n + 1)
  } catch {
    // No vault to read here: the graph draws without links.
  } finally {
    isIndexing = false
  }
}

async function openFolder($: EngineInterface, dir: string) {
  await $.process.run(['open', dir])
}

async function noteVault(
  $: EngineInterface,
  paths: string[],
  kind: ReadKind,
  size: number,
) {
  if (paths.length === 0) return
  // Numbered as the chat numbers its prompts, the one running included.
  const turn = Math.max(1, await $.session.turns())
  // A result's size is only known for the call as a whole: it is shared
  // between the paths, at about four characters a token.
  const each = Math.round(size / 4 / paths.length)
  await update($, reads, list =>
    [...list, ...paths.map(path => ({ path, kind, turn, tokens: each }))].slice(-2000),
  )
}

async function openPane($: EngineInterface) {
  await update($, isPaneClosed, () => false)
  await $.ui.open({ id: PANE, title: TITLE })
}

// ---------------------------------------------------------------- after a restart
//
// The pane's state lives as long as the session's process. When the app stops
// an idle chat and starts it again later, that state is gone, so it is rebuilt:
// the vault reads and folders from the chat's transcript on disk, and each
// turn's cost (which the transcript does not hold in a usable form) from the
// mod's own store, kept per session.

const STORE_SESSIONS = 'sessions'
const KEEP_SESSIONS = 40

/** The chat's transcript file: `<config>/projects/<project>/<session id>.jsonl`. */
async function transcriptPath($: EngineInterface): Promise<string | null> {
  const id = await $.session.id()
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${homeDir}/.claude`
  try {
    for (const dir of await $.fs.list(`${config}/projects`)) {
      if (dir.kind !== 'dir') continue
      const file = `${config}/projects/${dir.name}/${id}.jsonl`
      if (await $.fs.exists(file)) return file
    }
  } catch {
    // No projects folder to look in.
  }
  return null
}

type TranscriptEntry = {
  type?: string
  isMeta?: boolean
  uuid?: string
  promptId?: string
  attachment?: { type?: string; path?: string; snapshot?: { workingDirectory?: string; additionalWorkingDirectories?: string[] } }
  message?: { content?: unknown }
}
type ContentBlock = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; text?: string }

/** Rebuilds the vault reads, folders and turn costs after the session's process restarted. */
async function rebuildSession($: EngineInterface) {
  await ensureVault($)
  const id = await $.session.id()

  // Turn costs: from the store, when this session has none in memory.
  if ((await read($, turns)).length === 0) {
    try {
      const saved = await $.store.get(`turns:${id}`)
      if (Array.isArray(saved) && saved.length > 0) await update($, turns, () => saved as Turn[])
    } catch {
      // No store to read: the turn costs start again from here.
    }
  }

  // Only after a restart: while the process lives, memory already holds it all.
  if ((await read($, reads)).length > 0) return
  const file = await transcriptPath($)
  if (!file) return
  let text: string
  try {
    text = await $.fs.read(file)
  } catch {
    return
  }

  const prompts = new Set<string>()
  const calls = new Map<string, { name: string; input: Record<string, unknown>; turn: number; cwd: string }>()
  const sizes = new Map<string, number>()
  const mentions: { path: string; turn: number }[] = []
  const dirs = new Set<string>()
  let cwd = ''

  // Most of a long transcript is request records and images; only lines that
  // can hold a prompt, a tool call or result, or a folder are decoded.
  for (const line of text.split('\n')) {
    if (!line) continue
    const isAssistant = line.includes('"type":"assistant"')
    if (isAssistant ? !line.includes('"tool_use"') : !line.includes('"type":"user"') && !line.includes('"type":"attachment"')) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    const content = entry.message?.content
    const blocks = Array.isArray(content) ? (content as ContentBlock[]) : []
    if (entry.type === 'attachment') {
      const a = entry.attachment
      if (a?.type === 'environment') {
        cwd = a.snapshot?.workingDirectory ?? cwd
        for (const d of a.snapshot?.additionalWorkingDirectories ?? []) dirs.add(d)
      } else if ((a?.type === 'directory' || a?.type === 'nested_memory' || a?.type === 'file') && a.path) {
        mentions.push({ path: a.path, turn: Math.max(1, prompts.size) })
      }
      continue
    }
    if (entry.type === 'user' && !entry.isMeta) {
      const isPrompt = typeof content === 'string' || blocks.some(b => b.type === 'text')
      if (isPrompt) {
        prompts.add(entry.promptId ?? entry.uuid ?? String(prompts.size))
        const words = typeof content === 'string' ? content : blocks.map(b => b.text ?? '').join(' ')
        for (const m of words.matchAll(/@"?([^\s"]+)"?/g)) mentions.push({ path: m[1] ?? '', turn: prompts.size })
      }
      for (const b of blocks) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue
        const c = b.content
        const size =
          typeof c === 'string'
            ? c.length
            : Array.isArray(c)
              ? (c as ContentBlock[]).reduce((n, x) => n + (x.text?.length ?? 0), 0)
              : 0
        sizes.set(b.tool_use_id, Math.max(sizes.get(b.tool_use_id) ?? 0, size))
      }
    }
    if (entry.type === 'assistant') {
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.id && b.name && !calls.has(b.id)) {
          calls.set(b.id, { name: b.name, input: b.input ?? {}, turn: Math.max(1, prompts.size), cwd })
        }
      }
    }
  }

  // Find the vault from what the chat touched, if it is not known yet.
  if (!vaultRootPath) {
    const touched = [
      ...mentions.map(m => m.path),
      ...[...calls.values()].map(c =>
        ['file_path', 'notebook_path', 'path', 'command'].map(k => String(c.input[k] ?? '')).join(' '),
      ),
    ]
    for (const t of touched) {
      await findVaultIn($, t)
      if (vaultRootPath) break
    }
  }
  if (!vaultRootPath) return

  const rebuilt: VaultRead[] = []
  const add = (paths: string[], kind: ReadKind, turn: number, size: number) => {
    const each = paths.length ? Math.round(size / 4 / paths.length) : 0
    for (const path of paths) rebuilt.push({ path, kind, turn, tokens: each })
  }
  for (const m of mentions) add(vaultPaths(m.path), 'mention', m.turn, 0)
  for (const [callId, c] of calls) {
    const field = (k: string) => (typeof c.input[k] === 'string' ? (c.input[k] as string) : '')
    const size = sizes.get(callId) ?? 0
    if (c.name === 'Read') add(vaultPaths(field('file_path')), 'read', c.turn, size)
    else if (c.name === 'Edit' || c.name === 'Write' || c.name === 'NotebookEdit') {
      add(vaultPaths(field('file_path') || field('notebook_path')), 'edit', c.turn, 0)
    } else if (c.name === 'Grep' || c.name === 'Glob') {
      add(vaultPaths(field('path')).map(p => (p.endsWith('/') ? p : `${p}/`)), 'search', c.turn, size)
    } else if (c.name === 'Bash') {
      const inVault = vaultPaths(c.cwd)[0]
      const cwdInVault = inVault === undefined ? null : inVault === './' ? '' : inVault.replace(/\/$/, '')
      add(shellVaultPaths(field('command'), cwdInVault), 'shell', c.turn, size)
    }
  }

  // The transcript holds every read so far, so it replaces what memory has.
  if (rebuilt.length > 0) await update($, reads, () => rebuilt.slice(-2000))
  if (dirs.size > 0) {
    await update($, folders, list => [...new Set([...list, ...dirs])])
  }
}

/** Keeps this session's turn costs where a restart can find them. */
async function saveTurns($: EngineInterface, list: Turn[]) {
  const id = await $.session.id()
  await $.store.set(`turns:${id}`, list.slice(-200))
  const known = await $.store.get(STORE_SESSIONS)
  const ids = [...(Array.isArray(known) ? (known as string[]) : []).filter(x => x !== id), id]
  for (const old of ids.slice(0, Math.max(0, ids.length - KEEP_SESSIONS))) {
    await $.store.delete(`turns:${old}`)
  }
  await $.store.set(STORE_SESSIONS, ids.slice(-KEEP_SESSIONS))
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  configuredVault = typeof options.vaultPath === 'string' ? options.vaultPath.trim() : ''

  // Per-turn working values, kept in the module: a reload mid-turn only
  // loses that turn's cost split.
  let costAtStart: number | undefined
  let mainTurnId: string | undefined
  let subagentRuns = 0

  on('session.start', async ($, e, next) => {
    await ensureVault($)
    const stored = await read($, knownVault)
    if (!vaultRootPath && stored) setVaultRoot(stored)
    await findVaultIn($, e.cwd)
    await $.command.register({
      name: 'context-rail',
      description: 'Open the Session pane: costs, limits, context, folders and vault reads',
    })
    const started = await next(e)
    void refreshTotals($)
    // After the app restarts an idle chat, the pane's memory is empty: rebuild
    // it before the pane opens, so it never shows a half-empty picture.
    await rebuildSession($).catch(() => undefined)
    if (!(await read($, isPaneClosed))) void openPane($)
    return started
  })

  on('command.run', { command: 'context-rail' }, async $ => {
    await openPane($)
    return { text: 'Session pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE && e.origin.kind === 'person') {
      await update($, isPaneClosed, () => true)
    }
    return closed
  })

  on('classic.DirectoryAdded', async ($, e, next) => {
    const dir = e.directory
    await update($, folders, list => (list.includes(dir) ? list : [...list, dir]))
    await findVaultIn($, dir)
    await noteVault($, vaultPaths(dir), 'mention', 0)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await findVaultIn($, e.text)
    // An @-mention of a vault file or folder.
    const mentioned = [...e.text.matchAll(/@"?([^\s"]+)"?/g)].flatMap(m =>
      vaultPaths(m[1] ?? ''),
    )
    await noteVault($, mentioned, 'mention', 0)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    const input = e as unknown as Record<string, unknown>
    const field = (key: string) => {
      const value = input[key]
      return typeof value === 'string' ? value : ''
    }
    const size = ran.text?.length ?? 0
    await findVaultIn($, `${field('file_path')} ${field('notebook_path')} ${field('path')} ${field('command')}`)

    if (e.tool === 'Read') {
      await noteVault($, vaultPaths(field('file_path')), 'read', size)
    } else if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      await noteVault($, vaultPaths(field('file_path') || field('notebook_path')), 'edit', 0)
    } else if (['Grep', 'Glob'].includes(e.tool)) {
      const where = vaultPaths(field('path')).map(p => (p.endsWith('/') ? p : `${p}/`))
      await noteVault($, where, 'search', size)
    } else if (e.tool === 'Bash') {
      const cwd = await $.session.cwd()
      const inVault = vaultPaths(cwd)[0]
      const cwdInVault =
        inVault === undefined ? null : inVault === './' ? '' : inVault.replace(/\/$/, '')
      await noteVault($, shellVaultPaths(field('command'), cwdInVault), 'shell', size)
    }
    return ran
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      mainTurnId = e.turnId
      subagentRuns = 0
      costAtStart = (await $.session.usage()).cost?.usd
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined) {
      subagentRuns += 1
      return done
    }
    if (e.turnId !== mainTurnId) return done

    const now = await refreshTotals($)
    const u = e.usage
    const cost =
      now.usd !== undefined && costAtStart !== undefined
        ? Math.max(0, now.usd - costAtStart)
        : undefined
    const answer = e.answer.trim()
    const number = await $.session.turns()

    await update($, turns, list => {
      const turn: Turn = {
        n: Math.max(number, (list.at(-1)?.n ?? 0) + 1),
        usd: cost,
        durationMs: e.durationMs,
        model: u?.model,
        input: u?.input_tokens ?? 0,
        output: u?.output_tokens ?? 0,
        cacheRead: u?.cache_read_input_tokens ?? 0,
        cacheWrite: u?.cache_creation_input_tokens ?? 0,
        subagentRuns,
        answerHash: answer ? hash(answer) : undefined,
      }
      return [...list, turn].slice(-500)
    })
    void saveTurns($, await read($, turns)).catch(() => undefined)
    mainTurnId = undefined
    return done
  })

  // A way back to the pane when the person closed it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isPaneClosed))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box gap={1} alignItems="center">
        <Text dimColor>The Session pane is closed.</Text>
        <Button key="reopen" onPress={() => openPane($)}>
          Open it
        </Button>
      </Box>
    )
  })

  // Each turn's cost, and the vault files it used, under the reply that
  // closed it.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const drawn = await next(e)
    const text = e.props.text.trim()
    if (!text || e.props.isSummary) return drawn

    const key = hash(text)
    const turn = (await read($, turns)).find(t => t.answerHash === key)
    if (!turn) return drawn

    const { Box, Text } = $.ui.resolve(e)
    const share = cachedShare(turn)
    const cost = [
      `Turn ${turn.n}: ${usd(turn.usd)}`,
      share === undefined ? undefined : `${share}% of input from cache`,
    ].filter(Boolean)
    const used = [
      ...new Set(
        (await read($, reads))
          .filter(r => r.turn === turn.n && !isFolder(r.path))
          .map(r => fileLabel(r.path)),
      ),
    ]

    return (
      <Box flexDirection="column">
        {drawn}
        <Text dimColor tabular>
          {cost.join(' · ')}
        </Text>
        {used.length > 0 && (
          <Text dimColor>
            {VAULT_NAME}: {used.join(', ')}
          </Text>
        )}
      </Box>
    )
  })


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const list = await read($, turns)
    const sum = await read($, totals)
    const vault = await read($, reads)
    const added = await read($, folders)
    const stored = await read($, open)
    const shown: string[] = Array.isArray(stored) ? stored : []
    const now = await $.clock.now()
    const cwd = await $.session.cwd()
    const promptCount = await $.session.turns()
    const last = list.at(-1)
    const isOpen = (id: string) => shown.includes(id)
    const toggle = (id: string) => () =>
      update($, open, current => {
        const ids: string[] = Array.isArray(current) ? current : []
        return ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]
      })

    // ---- drawing pieces

    // A thin rounded bar like the rail's, in coloured segments: an image on
    // the graphical surfaces, a row of blocks in the terminal.
    const bar = (key: string, alt: string, segments: { share: number; color: string }[]) => {
      if (Svg) {
        let x = 0
        const rects = segments
          .map(s => {
            const w = Math.max(0, Math.min(1000 - x, s.share * 1000))
            const r = `<rect x="${x.toFixed(1)}" width="${w.toFixed(1)}" height="18" fill="${s.color}"/>`
            x += w
            return r
          })
          .join('')
        return (
          <Svg
            key={key}
            alt={alt}
            source={`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="18" viewBox="0 0 1000 18"><defs><clipPath id="r"><rect width="1000" height="18" rx="9"/></clipPath></defs><g clip-path="url(#r)"><rect width="1000" height="18" fill="#8a8a8a" fill-opacity="0.22"/>${rects}</g></svg>`}
          />
        )
      }
      const cells = Math.max(10, Math.min(40, e.props.bodyColumns))
      return (
        <Text key={key}>
          {segments.map((s, i) => (
            <Text key={`${key}-${i}`} color={s.color}>
              {'━'.repeat(Math.round(s.share * cells))}
            </Text>
          ))}
          <Text dimColor>
            {'━'.repeat(Math.max(0, cells - segments.reduce((n, s) => n + Math.round(s.share * cells), 0)))}
          </Text>
        </Text>
      )
    }

    const heading = (words: string) => <Text weight="medium">{words}</Text>

    const row = (label: string, value: string) => (
      <Box justifyContent="space-between" gap={1}>
        <Text>{label}</Text>
        <Text tabular>{value}</Text>
      </Box>
    )

    const detail = (key: string, label: string, value: string, isDim = true) => (
      <Box key={key} justifyContent="space-between" gap={1} paddingLeft={2}>
        <Text dimColor={isDim}>{label}</Text>
        <Text dimColor={isDim} tabular>
          {value}
        </Text>
      </Box>
    )

    // A row that opens and closes what is under it, with the rail's arrow.
    const disclosure = (id: string, label: string, value: string, isDim = false) => (
      <Box justifyContent="space-between" gap={1}>
        <Button key={id} plain dimColor={isDim} onPress={toggle(id)}>
          <Text dimColor>{isOpen(id) ? '⌄ ' : '› '}</Text>
          {label}
        </Button>
        <Text tabular dimColor={isDim}>
          {value}
        </Text>
      </Box>
    )

    // ---- cost
    const cost = (
      <Box flexDirection="column" gap={1}>
        {heading('Cost')}
        {row('Session total', usd(sum.usd))}
        <Box flexDirection="column">
          {disclosure('turns', 'Turns', String(Math.max(promptCount, list.length)))}
          {isOpen('turns') &&
            (list.length === 0
              ? detail('none', 'No finished turns yet', '')
              : list
                  .slice(-30)
                  .reverse()
                  .map(t =>
                    detail(`t${t.n}`, `Turn ${t.n}, ${seconds(t.durationMs)}`, usd(t.usd)),
                  ))}
        </Box>
        <Box flexDirection="column">
          {disclosure('last', 'Last turn', last ? usd(last.usd) : 'n/a')}
          {isOpen('last') && last && (
            <Box flexDirection="column">
              {detail('time', 'Time', seconds(last.durationMs))}
              {last.model && detail('model', 'Model', last.model)}
              {detail('in', 'New input', tokens(last.input))}
              {detail('cr', 'Read from cache', tokens(last.cacheRead))}
              {detail('cw', 'Written to cache', tokens(last.cacheWrite))}
              {detail('out', 'Output', tokens(last.output))}
              {cachedShare(last) !== undefined &&
                detail('share', 'Input from cache', `${cachedShare(last)}%`)}
              {last.subagentRuns > 0 &&
                detail('sub', 'Subagent runs', String(last.subagentRuns))}
            </Box>
          )}
        </Box>
      </Box>
    )

    // ---- plan limits
    const limits = sum.limits.length > 0 && (
      <Box flexDirection="column" gap={1}>
        {heading('Plan limits')}
        {sum.limits.map(l => (
          <Box key={l.kind} flexDirection="column">
            {row(limitName(l.kind), `${l.percentUsed}% used`)}
            {bar(`bar-${l.kind}`, `${limitName(l.kind)}: ${l.percentUsed}% used`, [
              { share: l.percentUsed / 100, color: l.percentUsed >= 80 ? AMBER : BLUE },
            ])}
            {resetsIn(l.resetsAt, now) && <Text dimColor>{resetsIn(l.resetsAt, now)}</Text>}
          </Box>
        ))}
      </Box>
    )

    const dirs = [cwd, ...added.filter(d => d !== cwd)]
    const hasVaultFolder = dirs.some(d => vaultPaths(d).length > 0)
    // ---- vault: what was read, by folder; what the last reply used is
    // drawn bright, the rest dim.
    const tokensOf = new Map<string, number>()
    for (const r of vault) tokensOf.set(r.path, Math.max(tokensOf.get(r.path) ?? 0, r.tokens))
    const usedNow = new Set(vault.filter(r => r.turn === promptCount).map(r => r.path))
    const files = [...tokensOf.keys()].filter(p => !isFolder(p))
    const vaultTokens = [...tokensOf.values()].reduce((n, x) => n + x, 0)
    const groups = new Map<string, string[]>()
    for (const p of tokensOf.keys()) {
      const g = groupOf(p)
      groups.set(g, [...(groups.get(g) ?? []), p])
    }
    const groupRows = [...groups.entries()]
      .map(([name, paths]) => ({
        name,
        paths: paths.sort((a, b) => (tokensOf.get(b) ?? 0) - (tokensOf.get(a) ?? 0)),
        tokens: paths.reduce((n, p) => n + (tokensOf.get(p) ?? 0), 0),
        isUsed: paths.some(p => usedNow.has(p)),
      }))
      .sort((a, b) => b.tokens - a.tokens || b.paths.length - a.paths.length)
    const shadeSeen = new Map<string, number>()
    const groupColor = new Map(
      groupRows.map(g => {
        const base = noteColor(g.paths.find(p => !isFolder(p)) ?? g.paths[0] ?? g.name)
        const i = shadeSeen.get(base) ?? 0
        shadeSeen.set(base, i + 1)
        return [g.name, lighten(base, Math.min(0.6, i * 0.3))]
      }),
    )
    const isMissing = vault.length === 0 && !hasVaultFolder

    // ---- the graph's data: each note read, at its size and latest turn
    await read($, indexStamp)
    await ensureVault($)
    const root = vaultRootPath
    if (Svg && root && vault.length > 0 && !vaultIndex) void buildIndex($, root)
    const lastTurnOf = new Map<string, number>()
    for (const r of vault) {
      if (!isFolder(r.path)) lastTurnOf.set(r.path, Math.max(lastTurnOf.get(r.path) ?? 0, r.turn))
    }
    const graphNodes: GraphNode[] = [...lastTurnOf.entries()].map(([path, turn]) => ({
      path,
      turn,
      tokens: tokensOf.get(path) || vaultIndex?.tokens.get(path) || 0,
    }))
    const focused = await read($, focus)

    // ---- the chosen view's drawing
    const storedView = await read($, view)
    const chosenView = VIEWS.some(v => v.id === storedView) ? storedView : 'map'
    // Every chart is drawn at one design width and scales to fill the pane,
    // so a wider rail draws a bigger chart, its text included.
    const drawWidth = 360
    let viewSource = ''
    let viewAlt = ''
    if (chosenView === 'share') {
      viewAlt = 'Donut of the vault tokens loaded, by folder'
      viewSource = shareSvg(
        groupRows
          .filter(g => g.tokens > 0)
          .map(g => ({
            name: g.name,
            tokens: g.tokens,
            area: areaOfGroup(g.name),
            isUsed: g.isUsed,
            color: noteColor(g.paths.find(p => !isFolder(p)) ?? g.name),
          })),
        drawWidth,
      )
    } else if (chosenView === 'timeline') {
      viewAlt = 'Vault notes read in each turn, stacked by tokens'
      const seenAt = new Map<string, number>()
      const perTurn = new Map<string, { path: string; turn: number; tokens: number; isRepeat: boolean }>()
      for (const r of [...vault].sort((a, b) => a.turn - b.turn)) {
        if (isFolder(r.path)) continue
        const key = `${r.turn}|${r.path}`
        if (perTurn.has(key)) continue
        const firstTurn = seenAt.get(r.path)
        if (firstTurn === undefined) seenAt.set(r.path, r.turn)
        perTurn.set(key, {
          path: r.path,
          turn: r.turn,
          tokens: tokensOf.get(r.path) ?? 0,
          isRepeat: firstTurn !== undefined && firstTurn < r.turn,
        })
      }
      viewSource = timelineSvg([...perTurn.values()], Math.max(promptCount, 1), drawWidth)
    } else if (chosenView === 'treemap') {
      viewAlt = 'Vault notes loaded as rectangles sized by tokens, grouped by area'
      viewSource = treemapSvg(
        graphNodes.map(n => ({ path: n.path, tokens: n.tokens, isLatest: n.turn === promptCount })),
        drawWidth,
      )
    } else if (chosenView === 'map') {
      viewAlt = `Graph of the ${files.length} vault notes read this session, sized by tokens, with the notes they link to`
      viewSource = graphSvg({
        used: graphNodes,
        latestTurn: promptCount,
        focus: focused,
        index: vaultIndex,
        width: drawWidth,
      })
    }
    // The pane caps an image's height unless it is given one, so the chart is
    // sized here: the pane's width (cells of its code font, about 7.8 pixels
    // each) and the chart's own proportions, so it grows both ways.
    const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(viewSource)
    const viewAspect = box ? Number(box[2]) / Number(box[1]) : 1
    const chartWidth = Math.max(240, Math.round(e.props.bodyColumns * 7.8))
    const gapList = chosenView === 'gaps' ? gaps(graphNodes, vaultIndex, 15) : []
    const gapRows =
      chosenView !== 'gaps' ? null : !vaultIndex ? (
        <Text dimColor>Reading the vault's links…</Text>
      ) : gapList.length === 0 ? (
        <Text dimColor>Every linked note is loaded</Text>
      ) : (
        <Box flexDirection="column">
          <Box justifyContent="space-between" gap={1}>
            <Text dimColor>Linked from loaded notes</Text>
            <Text dimColor>Links</Text>
          </Box>
          {gapList.map(g => (
            <Box key={`gap-${g.path}`} flexDirection="column" hover={{ scope: `gap-${g.path}` }}>
              <Box justifyContent="space-between" gap={1}>
                <Text>{noteName(g.path)}</Text>
                <Text tabular>{String(g.sources.length)}</Text>
              </Box>
              <Box display="none" hover={{ scope: `gap-${g.path}`, display: 'flex' }} paddingLeft={2}>
                <Text dimColor>
                  {`${groupOf(g.path)} · ${tokens(g.tokens)} · from ${g.sources.map(noteName).join(', ')}`}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      )

    // ---- context, coloured by what fills it
    const ctx = sum.context
    // The vault's notes arrive as tool results, so they sit inside Messages:
    // shown as their own part, taken out of Messages, never more than it holds.
    const messageTokens = ctx?.parts.find(p => p.name === 'Messages')?.tokens ?? 0
    const vaultInContext = Math.min(vaultTokens, messageTokens)
    const ctxParts = (ctx?.parts ?? []).flatMap(part =>
      part.name === 'Messages' && vaultInContext > 0
        ? [
            { ...part, tokens: part.tokens - vaultInContext },
            { name: VAULT_NAME, tokens: vaultInContext, kind: 'used' },
          ]
        : [part],
    )
    const context = ctx && ctx.percent !== undefined && (
      <Box flexDirection="column" gap={1}>
        {heading('Context')}
        <Box flexDirection="column">
          {disclosure(
            'context',
            `${ctx.percent}% used`,
            `${tokens(ctx.tokens ?? 0)} / ${tokens(ctx.window)}`,
          )}
          {bar(
            'bar-context',
            `Context: ${ctx.percent}% used`,
            ctxParts.map(part => ({ share: part.tokens / ctx.window, color: partColor(part.name) })),
          )}
          {isOpen('context') &&
            ctxParts.map(part => (
              <Box key={`c-${part.name}`} justifyContent="space-between" gap={1} paddingLeft={2}>
                <Text>
                  <Text color={partColor(part.name)}>■ </Text>
                  <Text dimColor>{part.name}</Text>
                </Text>
                <Text dimColor tabular>
                  {tokens(part.tokens)}
                </Text>
              </Box>
            ))}
        </Box>
      </Box>
    )

    // ---- folders: a name with a folder mark; the path shows on hover,
    // and a press opens the folder.
    const folderList = (
      <Box flexDirection="column" gap={1}>
        {heading('Folders')}
        <Box flexDirection="column">
          {dirs.map((d, i) => (
            <Box key={`d-${i}`} flexDirection="column" hover={{ scope: `dir-${i}` }}>
              <Box gap={1} alignItems="center">
                {Svg ? (
                  <Svg alt="Folder" width={16} height={16} source={FOLDER_ICON} />
                ) : (
                  <Text dimColor>▸</Text>
                )}
                <Button
                  key={`open-${i}`}
                  plain
                  hover={{ scope: `dir-${i}`, underline: true }}
                  onPress={() => openFolder($, d)}
                >
                  {d.split('/').filter(Boolean).pop() ?? d}
                </Button>
              </Box>
              <Box display="none" hover={{ scope: `dir-${i}`, display: 'flex' }} paddingLeft={3}>
                <Text dimColor wrap="truncate-start">
                  {shortPath(d)}
                </Text>
              </Box>
            </Box>
          ))}
          {isMissing && (
            <Box gap={1} alignItems="center">
              {Svg ? (
                <Svg alt="Missing folder" width={16} height={16} source={FOLDER_MISSING_ICON} />
              ) : (
                <Text color="warning">✕</Text>
              )}
              <Text color="warning">{root ? `${VAULT_NAME} not added` : `No ${VAULT_NAME} in this session`}</Text>
            </Box>
          )}
        </Box>
      </Box>
    )

    const vaultBody = isMissing ? (
      <Text dimColor>Nothing read yet</Text>
    ) : vault.length === 0 ? (
      <Text dimColor>Added, nothing read yet</Text>
    ) : (
      <Box flexDirection="column" gap={1}>
        {row(
          `${files.length} ${files.length === 1 ? 'file' : 'files'} read`,
          vaultTokens > 0 ? tokens(vaultTokens) : '',
        )}
        <Box justifyContent="space-between" alignItems="center" gap={1}>
          <Box gap={2}>
            {VIEWS.map(v => (
              <Button
                key={`view:${v.id}`}
                plain
                dimColor={chosenView !== v.id}
                hover={{ scope: `view-${v.id}`, dimColor: false }}
                onPress={() => update($, view, () => v.id)}
              >
                {v.icon}
              </Button>
            ))}
          </Box>
          <Text dimColor>{VIEWS.find(v => v.id === chosenView)?.label ?? ''}</Text>
        </Box>
        {chosenView === 'gaps'
          ? gapRows
          : Svg && (
              <Svg
                key={`view-${chosenView}`}
                isInteractive
                alt={viewAlt}
                source={viewSource}
                width={chartWidth}
                height={Math.round(chartWidth * viewAspect)}
              />
            )}
        <Box flexDirection="column" gap={1}>
          {groupRows.map(g => {
            const share = vaultTokens > 0 ? g.tokens / vaultTokens : 0
            const value =
              g.tokens > 0
                ? `${Math.round(share * 100)}% · ${tokens(g.tokens)}`
                : `${g.paths.length} ${g.paths.length === 1 ? 'item' : 'items'}`
            return (
              <Box key={`g-${g.name}`} flexDirection="column">
                {disclosure(`g:${g.name}`, g.name, value, !g.isUsed)}
                {g.tokens > 0 &&
                  bar(`bar-g-${g.name}`, `${g.name}: ${Math.round(share * 100)}% of vault tokens read`, [
                    { share, color: `${groupColor.get(g.name) ?? BLUE}${g.isUsed ? '' : '66'}` },
                  ])}
                {isOpen(`g:${g.name}`) &&
                  g.paths.map(p =>
                    isFolder(p) ? (
                      detail(`p-${p}`, `${fileLabel(p)} (looked through)`, '', !usedNow.has(p))
                    ) : (
                      <Box key={`p-${p}`} justifyContent="space-between" gap={1} paddingLeft={2}>
                        <Button
                          key={`f:${p}`}
                          plain
                          dimColor={!usedNow.has(p) && focused !== p}
                          onPress={() => update($, focus, current => (current === p ? null : p))}
                        >
                          {focused === p ? `● ${fileLabel(p)}` : fileLabel(p)}
                        </Button>
                        <Text dimColor={!usedNow.has(p)} tabular>
                          {(tokensOf.get(p) ?? 0) > 0 ? tokens(tokensOf.get(p) ?? 0) : ''}
                        </Text>
                      </Box>
                    ),
                  )}
              </Box>
            )
          })}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={2}>
        {folderList}
        {context}
        <Box flexDirection="column" gap={1}>
          {heading(VAULT_NAME)}
          {vaultBody}
        </Box>
        {limits}
        {cost}
      </Box>
    )
  })
}

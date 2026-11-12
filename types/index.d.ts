export type Turn = {
  n: number
  usd?: number
  durationMs: number
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  subagentRuns: number
  answerHash?: string
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type ContextPart = { name: string; tokens: number; kind: string }

export type ContextFill = {
  tokens?: number
  window: number
  percent?: number
  parts: ContextPart[]
}

export type Totals = {
  usd?: number
  limits: Limit[]
  context?: ContextFill
  checkedAt: number
}

/** How a vault path reached the session. */
export type ReadKind = 'read' | 'edit' | 'search' | 'shell' | 'mention' | 'auto'

/** One time a vault path was used: `path` is relative to the vault root. */
export type VaultRead = {
  path: string
  kind: ReadKind
  turn: number
  tokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-rail': {
      turns: Shaped<Turn[]>
      totals: Shaped<Totals>
      reads: Shaped<VaultRead[]>
      folders: string[]
      open: Shaped<string[]>
      isPaneClosed: boolean
      focus: string | null
      indexStamp: number
      view: string
      knownVault: string | null
      isRebuilding: boolean
    }
  }
}

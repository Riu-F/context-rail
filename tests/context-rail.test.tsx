import { expect, test } from 'claude-code/testing'

import { noteColor, parseColorGroups, setColorRules } from '../hooks/graph'

const PANE = {
  plugin: 'context-rail',
  component: 'Pane',
  requestId: 'context-rail',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const VAULT = '/Users/someone/Desktop/claude-context'

function engine(on: any, cost: { usd: number }, alsoExists: (path: string) => boolean = () => false) {
  on('clock.now', () => ({ value: 1_000 }))
  on('env.get', (_: unknown, e: any) => ({ value: String(e.name ?? e) === 'HOME' ? '/Users/someone' : undefined }))
  on('session.id', () => ({ value: 'abc123' }))
  // The fake vault is the one folder holding `.obsidian`.
  on('fs.exists', (_: unknown, e: any) => {
    const path = String(e.path ?? e)
    return { value: path === `${VAULT}/.obsidian` || alsoExists(path) }
  })
  on('session.cwd', () => ({ value: '/Users/someone/project' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        window: 1_000_000,
        tokens: 171_000,
        percent: 17,
        breakdown: {
          categories: [
            { name: 'Messages', tokens: 109_200, color: 'promptBorder', isDeferred: false, kind: 'used' },
            { name: 'Free space', tokens: 795_800, color: 'inactive', isDeferred: false, kind: 'free' },
          ],
        },
      },
      rateLimits: [{ kind: 'seven_day', percentUsed: 30 }],
      cost: { usd: cost.usd },
    },
  }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: 'x'.repeat(4000) }))
}

async function oneTurn($: any, cost: { usd: number }) {
  await $.turn.start({ turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: `${VAULT}/about-me/ui-rules.md` })
  cost.usd = 1.25
  await $.turn.complete({
    turnId: 't1',
    answer: 'All done.',
    durationMs: 42_000,
    isAborted: false,
    reason: 'completed',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 0,
    },
  })
}

test('the pane shows cost, limits, context and the vault file read', async ($, on) => {
  const cost = { usd: 1.0 }
  engine(on, cost)
  await oneTurn($, cost)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const text = async (re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
    expect(await text(/^\$1\.25$/)).toBe('$1.25')
    expect(await text(/^Weekly limit$/)).toBe('Weekly limit')
    expect(await text(/^1 file read$/)).toBe('1 file read')
    expect(await text(/~\/project/)).toBe('~/project')

    await ui.press({ key: 'context' })
    expect(await text(/^Messages$/)).toBe('Messages')
    expect(await text(/^Free space$/)).toBeUndefined()
    await ui.press({ key: 'context' })

    expect(await text(/^100% · 1\.0k$/)).toBe('100% · 1.0k')
    await ui.press({ key: 'g:about-me' })
    expect(await text(/^1\.0k$/)).toBe('1.0k')
    // Read in the latest turn: drawn bright, not dim.
    expect((await ui.find({ type: 'Text', text: /^ui-rules$/ }))?.props?.dimColor).toBeFalsy()
    await ui.press({ key: 'g:about-me' })
    await ui.unmount()

    const reply = await $.ui.mount({
      plugin: 'context-rail',
      surface,
      component: 'AssistantMessage',
      props: { text: 'All done.', isFirstOfReply: true },
    } as never)
    expect((await reply.find({ type: 'Text', text: /Turn 1/ }))?.text).toBe(
      'Turn 1: $0.25 · 75% of input from cache',
    )
    expect((await reply.find({ type: 'Text', text: /Obsidian vault/ }))?.text).toBe(
      'Obsidian vault: ui-rules',
    )
    await reply.unmount()
  }
})

test('with the vault set but not added or read, Folders warns it is missing', { options: { vaultPath: '/Users/someone/Desktop/claude-context' } }, async ($, on) => {
  engine(on, { usd: 0 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /not added/ }))?.text).toBe(
    'Obsidian vault not added',
  )
  await ui.unmount()
})

test('a shell command that moves into the vault counts the files it names', async ($, on) => {
  engine(on, { usd: 0 })
  await $.tool.call({
    tool: 'Bash',
    command:
      'cd ~/Desktop/claude-context && for f in now.md about-me/profile.md work/sanity.md; do head -c 6000 "$f"; done',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = async (re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
  expect(await text(/files read$/)).toBe('3 files read')
  await ui.press({ key: 'g:work' })
  expect(await ui.find({ key: 'f:work/sanity.md' } as never)).toBeDefined()
  await ui.press({ key: 'g:Vault root' })
  expect(await ui.find({ key: 'f:now.md' } as never)).toBeDefined()
  await ui.unmount()
})

test('a shell command that only looks around the vault is not a file read', async ($, on) => {
  engine(on, { usd: 0 })
  await $.tool.call({
    tool: 'Bash',
    command: 'cd ~/Desktop/claude-context && find . -name "*.md" -not -path "./.git/*" | xargs wc -c',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /files? read$/ }))?.text).toBe('0 files read')
  await ui.press({ key: 'g:Vault root' })
  expect((await ui.find({ type: 'Text', text: /looked through/ }))?.text).toBe(
    'Vault root (looked through)',
  )
  await ui.unmount()
})

test('the graph draws loaded notes, their links, and linked notes not loaded', async ($, on) => {
  engine(on, { usd: 0 })
  const vault: Record<string, string> = {
    'about-me/ui-rules.md': 'See [[writing-rules]] and [[caidence]].',
    'about-me/writing-rules.md': 'Pairs with [[ui-rules]].',
    'work/projects/caidence.md': 'Uses [[ui-rules]].',
  }
  on('fs.list', (_: unknown, e: any) => {
    const dir = String(e.path ?? e).replace(`${VAULT}`, '').replace(/^\//, '')
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of Object.keys(vault)) {
      if (dir && !p.startsWith(`${dir}/`)) continue
      const rest = dir ? p.slice(dir.length + 1) : p
      const [head, ...tail] = rest.split('/')
      names.set(head!, tail.length ? 'dir' : 'file')
    }
    return {
      value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  on('fs.read', (_: unknown, e: any) => ({
    value: vault[String(e.path ?? e).replace(`${VAULT}/`, '')] ?? '',
  }))

  await $.tool.call({ tool: 'Read', file_path: `${VAULT}/about-me/ui-rules.md` })
  await $.tool.call({ tool: 'Read', file_path: `${VAULT}/work/projects/caidence.md` })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The index builds in the background; the second draw has the links.
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svgs = await again.findAll({ type: 'Svg' } as never)
  const source = svgs.map((g: any) => String(g?.props?.source ?? '')).find(s => s.includes('id="i-m')) ?? ''
  expect(source).toContain('ui-rules · ')
  expect(source).toContain('caidence · ')
  expect(source).toContain('writing-rules · not loaded')
  expect(source).toContain('<line')
  await again.unmount()
})

test('each view draws, and the vault shows as its own part of the context', async ($, on) => {
  const cost = { usd: 0 }
  engine(on, cost)
  await oneTurn($, cost)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const text = async (re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
  // The vault's tokens are a purple segment of the context bar.
  const bars = await ui.findAll({ type: 'Svg' } as never)
  expect(bars.some((g: any) => String(g?.props?.source ?? '').includes('#c084fc'))).toBe(true)
  for (const id of ['share', 'timeline', 'treemap']) {
    await ui.press({ key: `view:${id}` })
    const svgs = await ui.findAll({ type: 'Svg' } as never)
    expect(svgs.some((g: any) => /ui-rules|about-me/.test(String(g?.props?.source ?? '')))).toBe(true)
  }
  await ui.press({ key: 'view:gaps' })
  expect(await text(/Reading the vault|Every linked note|Linked from/)).toBeDefined()
  await ui.press({ key: 'view:map' })
  await ui.unmount()
})

test("notes take the vault's Obsidian colour groups, else their folder's", async () => {
  const rules = parseColorGroups(
    JSON.stringify({
      colorGroups: [
        { query: 'file:Home', color: { a: 1, rgb: 0xff69b4 } },
        { query: 'path:work/projects OR path:work/log', color: { a: 1, rgb: 0x2e8b57 } },
        { query: 'tag:#draft', color: { a: 1, rgb: 0x123456 } },
      ],
    }),
  )
  expect(rules.length).toBe(2)
  setColorRules(rules)
  expect(noteColor('Home.md')).toBe('#ff69b4')
  expect(noteColor('work/projects/caidence.md')).toBe('#2e8b57')
  // No group matches: the folder's palette colour, the same every time.
  expect(noteColor('recipes/soup.md')).toBe(noteColor('recipes/bread.md'))
  setColorRules([])
})

test('a vault anywhere is found by its .obsidian folder, and named by the setting', async ($, on) => {
  engine(on, { usd: 0 })
  // Before any vault path is touched there is no vault.
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No Obsidian vault/ }))?.text).toBe(
    'No Obsidian vault in this session',
  )
  await ui.unmount()
  // Reading a note inside it finds the vault, and the read counts.
  await $.tool.call({ tool: 'Read', file_path: `${VAULT}/notes/idea.md` })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /files? read$/ }))?.text).toBe('1 file read')
  await ui.unmount()
})

test('the vaultPath setting names a vault with no .obsidian lookup', { options: { vaultPath: '~/Documents/Brain' } }, async ($, on) => {
  engine(on, { usd: 0 })
  await $.tool.call({ tool: 'Read', file_path: '/Users/someone/Documents/Brain/journal/today.md' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /files? read$/ }))?.text).toBe('1 file read')
  await ui.press({ key: 'g:journal' })
  expect(await ui.find({ key: 'f:journal/today.md' } as never)).toBeDefined()
  await ui.unmount()
})

test('after the app restarts a chat, the reads come back from its transcript', async ($, on) => {
  const file = '/Users/someone/.claude/projects/-Users-someone/abc123.jsonl'
  engine(on, { usd: 0 }, path => path === file)
  const transcript = [
    { type: 'user', message: { content: 'load some context' }, promptId: 'p1' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${VAULT}/about-me/ui-rules.md` } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(8000) }] } },
    { type: 'user', message: { content: 'and more' }, promptId: 'p2' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: `${VAULT}/work/projects/caidence.md` } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'y'.repeat(4000) }] } },
  ]
    .map(x => JSON.stringify(x))
    .join('\n')
  on('fs.list', (_: unknown, e: any) => ({
    value:
      String(e.path ?? e) === '/Users/someone/.claude/projects'
        ? [{ name: '-Users-someone', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
        : [],
  }))
  on('fs.read', (_: unknown, e: any) => ({ value: String(e.path ?? e) === file ? transcript : '' }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'context-rail' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ cwd: '/Users/someone', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /files? read$/ }))?.text).toBe('2 files read')
  expect((await ui.find({ type: 'Text', text: /^3\.0k$/ }))?.text).toBe('3.0k')
  await ui.unmount()
})

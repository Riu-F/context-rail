import { expect, test } from 'claude-code/testing'

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

function engine(on: any, cost: { usd: number }) {
  on('clock.now', () => ({ value: 1_000 }))
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
    expect((await reply.find({ type: 'Text', text: /Context vault/ }))?.text).toBe(
      'Context vault: ui-rules',
    )
    await reply.unmount()
  }
})

test('with no vault read, the vault shows as not loaded', async ($, on) => {
  engine(on, { usd: 0 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Not loaded/ }))?.text).toBe(
    'Not loaded in this session',
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
  expect(await text(/^sanity$/)).toBe('sanity')
  await ui.press({ key: 'g:Vault root' })
  expect(await text(/^now$/)).toBe('now')
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

// The session graph: the vault notes a session loaded, where they sit, how
// they link, and the notes they link to that were not loaded.
//
// Pure functions, no `$`: register.tsx builds the index and hands the data in.

/** Every note in the vault and the links between them, by vault-relative path. */
export type VaultIndex = {
  /** Path of each note by its lower-cased name, as `[[name]]` finds it. */
  byName: Map<string, string>
  /** About how many tokens each note holds. */
  tokens: Map<string, number>
  /** The notes each note links to or is linked from. */
  links: Map<string, Set<string>>
}

export type GraphNode = {
  path: string
  tokens: number
  /** The turn the note was last read in; 0 for a note linked but not loaded. */
  turn: number
}

export type GraphInput = {
  used: GraphNode[]
  latestTurn: number
  focus: string | null
  index: VaultIndex | null
  /** The width to draw at, in CSS pixels; the graph keeps text at one size and grows its layout. */
  width?: number
}

/** Links in a note's text, by the lower-cased note name they point at. */
export function linksIn(text: string): string[] {
  const names = new Set<string>()
  for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
    const name = (m[1] ?? '').trim().split('/').pop() ?? ''
    if (name) names.add(name.replace(/\.md$/i, '').toLowerCase())
  }
  return [...names]
}

export function noteName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '')
}

/** The vault area a note sits in: its top folder, or the root. */
export function areaOf(path: string): string {
  const parts = path.split('/').filter(p => p && p !== '.')
  return parts.length > 1 ? (parts[0] ?? 'root') : 'root'
}

// Areas keep their place around the circle, so the graph keeps its shape.
const AREA_ORDER = ['about-me', 'work', 'personal', 'prompts', 'web', 'root']
const AREA_COLORS: Record<string, string> = {
  'about-me': '#7F77DD',
  work: '#1D9E75',
  personal: '#D85A30',
  prompts: '#BA7517',
  web: '#378ADD',
  root: '#888780',
}
// For a vault whose folders have no colour of their own: a palette handed
// out by folder name, so a folder keeps its colour from one session to the next.
const PALETTE = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#BA7517', '#D4537E', '#5DCAA5', '#9b59b6', '#639922']

export function areaColor(area: string): string {
  if (area === 'root') return '#888780'
  return AREA_COLORS[area] ?? PALETTE[Math.floor(hash(area) * PALETTE.length) % PALETTE.length] ?? '#888780'
}

/** One of Obsidian's graph colour groups: a note matching any term takes its colour. */
export type ColorRule = { terms: { kind: 'path' | 'file'; value: string }[]; color: string }

let colorRules: ColorRule[] = []

/** The vault's own colours, from `.obsidian/graph.json`; none, and areas use the palette. */
export function setColorRules(rules: ColorRule[]) {
  colorRules = rules
}

/**
 * Obsidian's graph colour groups, as `.obsidian/graph.json` holds them. Only
 * `path:` and `file:` terms joined by OR are read; a group using anything
 * else (tags, AND) is skipped.
 */
export function parseColorGroups(json: string): ColorRule[] {
  try {
    const groups = (JSON.parse(json) as { colorGroups?: { query?: string; color?: { rgb?: number } }[] }).colorGroups ?? []
    return groups.flatMap(g => {
      const terms = (g.query ?? '').split(/\s+OR\s+/i).map(t => t.trim())
      const parsed = terms.map(t => {
        const m = /^(path|file):"?([^"]+)"?$/i.exec(t)
        return m ? { kind: (m[1] ?? '').toLowerCase() as 'path' | 'file', value: (m[2] ?? '').toLowerCase() } : null
      })
      if (parsed.length === 0 || parsed.some(t => t === null) || typeof g.color?.rgb !== 'number') return []
      return [{ terms: parsed as ColorRule['terms'], color: `#${g.color.rgb.toString(16).padStart(6, '0')}` }]
    })
  } catch {
    return []
  }
}

/** A note's colour: the first of the vault's colour groups it matches, else its area's. */
export function noteColor(path: string): string {
  const lower = path.toLowerCase()
  const name = (lower.split('/').pop() ?? lower).replace(/\.md$/, '')
  for (const rule of colorRules) {
    if (rule.terms.some(t => (t.kind === 'path' ? lower.includes(t.value) : name === t.value))) return rule.color
  }
  return areaColor(areaOf(path))
}

function hash(text: string, seed = 5381): number {
  let h = seed
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0) / 4294967295
}

/** The drawing's size and the circle inside it, from the width it gets. */
type Frame = { width: number; height: number; cx: number; cy: number; rim: number; scale: number }

function frameFor(width = 480): Frame {
  const w = Math.max(260, Math.min(1400, Math.round(width)))
  const height = Math.max(240, Math.min(820, Math.round(w * 0.82)))
  // Room for the area names: a column each side, a line top and bottom.
  const rim = Math.max(80, Math.min(w / 2 - 58, height / 2 - 20))
  return { width: w, height, cx: w / 2, cy: height / 2, rim, scale: Math.max(0.8, Math.min(1.8, rim / 168)) }
}

type Slice = { area: string; start: number; size: number }

/**
 * Each area's slice of the circle, sized by how many notes it holds in the
 * vault, in a fixed order: the vault's shape decides it, not the session's.
 */
function slices(areas: Map<string, number>): Slice[] {
  const present = [
    ...AREA_ORDER.filter(a => areas.has(a)),
    ...[...areas.keys()].filter(a => !AREA_ORDER.includes(a)).sort(),
  ]
  const weight = (a: string) => Math.sqrt(areas.get(a) ?? 1) + 1
  const total = present.reduce((n, a) => n + weight(a), 0)
  let start = -Math.PI / 2
  return present.map(area => {
    const size = (weight(area) / total) * Math.PI * 2
    const slice = { area, start, size }
    start += size
    return slice
  })
}

/** A note's place: its area's slice, then a spot fixed by its path. */
function place(path: string, all: Slice[], f: Frame): { x: number; y: number } {
  const slice = all.find(s => s.area === areaOf(path)) ?? all[0]
  const angle = slice ? slice.start + slice.size * (0.1 + 0.8 * hash(path)) : 0
  const radius = f.rim * (0.2 + 0.67 * Math.sqrt(hash(path, 7919)))
  return { x: f.cx + Math.cos(angle) * radius, y: f.cy + Math.sin(angle) * radius }
}

/** A hover label: shown the moment the item with the same id is pointed at. */
type Tip = { id: string; x: number; y: number; text: string }

/**
 * The hover labels, drawn last so they sit above everything, and the CSS that
 * shows each while its item is hovered (the pane draws the SVG in a frame
 * where :hover works).
 */
function tipLayer(tips: Tip[], width: number, height: number): string {
  const rules = tips.map(t => `svg:has(#i-${t.id}:hover) #t-${t.id}{opacity:1}`).join('')
  const style = `<style>.tip{opacity:0;pointer-events:none;transition:opacity .08s}[id^="i-"]{cursor:default}[id^="i-"]:hover{stroke:#ffffff;stroke-width:1.5;stroke-opacity:.9}${rules}</style>`
  const labels = tips
    .map(t => {
      const w = t.text.length * 7.3 + 18
      const x = Math.max(4, Math.min(width - w - 4, t.x - w / 2))
      const y = Math.max(4, Math.min(height - 26, t.y - 11))
      return `<g class="tip" id="t-${t.id}"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="24" rx="6" fill="#111111" fill-opacity="0.92" stroke="#ffffff" stroke-opacity="0.15"/><text x="${(x + 9).toFixed(1)}" y="${(y + 16.5).toFixed(1)}" font-size="13" fill="#f2f2f2">${escape(t.text)}</text></g>`
    })
    .join('')
  return style + labels
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
}

function k(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

/**
 * The graph as an SVG document, one unit to a CSS pixel at the given width, so
 * a wider pane gets a bigger graph with text the same size.
 */
export function graphSvg({ used, latestTurn, focus, index, width }: GraphInput): string {
  const f = frameFor(width)

  // Notes linked to what was loaded but not loaded themselves, the most
  // linked first.
  const ghosts = gaps(used, index).map(g => ({ path: g.path, tokens: g.tokens, turn: 0 }))

  const areaCount = new Map<string, number>()
  for (const path of index ? index.tokens.keys() : [...used, ...ghosts].map(n => n.path)) {
    areaCount.set(areaOf(path), (areaCount.get(areaOf(path)) ?? 0) + 1)
  }
  const sliceList = slices(areaCount)
  const nodes = [...used, ...ghosts].map(n => ({ ...n, ...place(n.path, sliceList, f) }))
  const at = new Map(nodes.map(n => [n.path, n]))
  const radius = (n: GraphNode) =>
    n.turn === 0 ? 2.5 : (4 + Math.sqrt(n.tokens / 1000) * 2.4) * f.scale
  // What the latest turn used is full strength; what earlier turns loaded
  // stays in the graph, clearly dimmer.
  const isLatest = (n: GraphNode) => n.turn > 0 && n.turn === latestTurn
  const opacity = (n: GraphNode) => (n.turn === 0 ? 0.22 : isLatest(n) ? 1 : 0.3)

  const edges: string[] = []
  if (index) {
    const seen = new Set<string>()
    for (const n of nodes) {
      for (const other of index.links.get(n.path) ?? []) {
        const m = at.get(other)
        const key = [n.path, other].sort().join('|')
        const isLoaded = n.turn > 0 && m?.turn !== undefined && m.turn > 0
        const isFocus = focus !== null && (n.path === focus || other === focus)
        if (!m || seen.has(key) || !(isLoaded || isFocus)) continue
        seen.add(key)
        const isNow = isLatest(n) || isLatest(m)
        edges.push(
          `<line x1="${n.x.toFixed(1)}" y1="${n.y.toFixed(1)}" x2="${m.x.toFixed(1)}" y2="${m.y.toFixed(1)}" stroke="#8a8a8a" stroke-width="${isFocus ? 1.4 : isNow ? 0.9 : 0.6}" stroke-opacity="${isFocus ? 0.9 : isNow ? 0.5 : 0.16}"${isLoaded ? '' : ' stroke-dasharray="2 3"'}/>`,
        )
      }
    }
  }

  // Area names sit outside the rim, at the middle of their slice; their
  // boxes are kept so note names stay clear of them.
  const rimBoxes: { x0: number; x1: number; y0: number; y1: number }[] = []
  const rim = sliceList
    .map(({ area, start, size }) => {
      const angle = start + size / 2
      const x = f.cx + Math.cos(angle) * (f.rim + 6)
      const y = f.cy + Math.sin(angle) * (f.rim + 6) + 4
      const anchor = Math.abs(Math.cos(angle)) < 0.25 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end'
      const isPresent = nodes.some(n => areaOf(n.path) === area)
      const biggestHere = nodes.filter(n => areaOf(n.path) === area).sort((a, b) => b.tokens - a.tokens)[0]
      const rimColor = biggestHere ? noteColor(biggestHere.path) : areaColor(area)
      const label = area === 'root' ? 'vault root' : area
      const w = label.length * 7.2
      const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2
      rimBoxes.push({ x0, x1: x0 + w, y0: y - 12, y1: y + 3 })
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="12.5" fill="${rimColor}" fill-opacity="${isPresent ? 0.95 : 0.35}">${area === 'root' ? 'vault root' : area}</text>`
    })
    .join('')

  const mapTips: Tip[] = []
  const circles = nodes
    .sort((a, b) => (a.turn === 0 ? -1 : 0) - (b.turn === 0 ? -1 : 0) || b.tokens - a.tokens)
    .map(n => {
      const isNow = isLatest(n)
      const isFocus = n.path === focus
      const color = noteColor(n.path)
      const cx = n.x.toFixed(1)
      const cy = n.y.toFixed(1)
      const r = radius(n)
      // A soft halo marks what the latest turn used.
      const halo = isNow
        ? `<circle cx="${cx}" cy="${cy}" r="${(r + 5 * f.scale).toFixed(1)}" fill="${color}" fill-opacity="0.22"/>`
        : ''
      const ring = isFocus ? ` stroke="#ffffff" stroke-width="2" stroke-opacity="0.95"` : ''
      const id = `m${mapTips.length}`
      mapTips.push({
        id,
        x: n.x,
        y: n.y - r - 14,
        text: n.turn === 0 ? `${noteName(n.path)} · not loaded` : `${noteName(n.path)} · ${k(n.tokens)}`,
      })
      return `<g>${halo}<circle id="i-${id}" cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="${opacity(n)}"${ring}/></g>`
    })
    .join('')

  // Names for the biggest loaded notes, the latest turn's, and the focused one.
  // Data-surface text: 11 units, below the 16px reading floor on purpose (a
  // graph label is read as part of the chart; the tooltip carries the rest).
  const named = nodes
    .filter(n => n.turn > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .filter((n, i) => i < 6 || n.turn === latestTurn || n.path === focus)
  // Placed biggest first, under the node or else over it; a name that would
  // overlap one already placed, or a node, is left to its tooltip.
  type Box = { x0: number; x1: number; y0: number; y1: number }
  const placed: Box[] = [...rimBoxes]
  const biggest = new Set(named.slice(0, 3).map(n => n.path))
  const hits = (box: Box) =>
    placed.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1) ||
    nodes.some(
      m => m.turn > 0 && m.x + radius(m) > box.x0 && m.x - radius(m) < box.x1 && m.y + radius(m) > box.y0 && m.y - radius(m) < box.y1,
    )
  const labels = named
    .sort((a, b) => (b.path === focus ? 1 : 0) - (a.path === focus ? 1 : 0) || b.tokens - a.tokens)
    .flatMap(n => {
      const name = noteName(n.path)
      const w = name.length * 6.9
      const r = radius(n)
      // Under, over, right of, then left of the node.
      const spots = [
        { x: n.x, y: n.y + r + 12, anchor: 'middle', x0: n.x - w / 2 },
        { x: n.x, y: n.y - r - 5, anchor: 'middle', x0: n.x - w / 2 },
        { x: n.x + r + 4, y: n.y + 4, anchor: 'start', x0: n.x + r + 4 },
        { x: n.x - r - 4, y: n.y + 4, anchor: 'end', x0: n.x - r - 4 - w },
      ]
        .map(s => ({ ...s, box: { x0: s.x0, x1: s.x0 + w, y0: s.y - 10, y1: s.y + 3 } }))
        .filter(s => s.box.x0 >= 0 && s.box.x1 <= f.width)
      // The three biggest notes always get a name, over a node if they must.
      const overLabel = (box: Box) =>
        placed.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)
      const spot =
        spots.find(s => !hits(s.box)) ??
        (biggest.has(n.path) ? spots.find(s => !overLabel(s.box)) : undefined)
      if (!spot) return []
      placed.push(spot.box)
      return [
        n.turn === latestTurn || n.path === focus
          ? `<text x="${spot.x.toFixed(1)}" y="${spot.y.toFixed(1)}" text-anchor="${spot.anchor}" font-size="12.5" font-weight="600" fill="#e6e6e6">${escape(name)}</text>`
          : `<text x="${spot.x.toFixed(1)}" y="${spot.y.toFixed(1)}" text-anchor="${spot.anchor}" font-size="12" fill="#8a8a8a" fill-opacity="0.8">${escape(name)}</text>`,
      ]
    })
    .join('')

  return `${svgOpen(f.width, f.height)}${edges.join('')}${circles}${labels}${rim}${tipLayer(mapTips, f.width, f.height)}</svg>`
}

// ---------------------------------------------------------------- other views

/** Notes linked to what was loaded but not loaded, the most linked first. */
export function gaps(used: GraphNode[], index: VaultIndex | null, limit = 40) {
  if (!index) return []
  const usedSet = new Set(used.map(n => n.path))
  const from = new Map<string, string[]>()
  for (const n of used) {
    for (const other of index.links.get(n.path) ?? []) {
      if (!usedSet.has(other)) from.set(other, [...(from.get(other) ?? []), n.path])
    }
  }
  return [...from.entries()]
    .map(([path, sources]) => ({ path, sources, tokens: index.tokens.get(path) ?? 0 }))
    .sort((a, b) => b.sources.length - a.sources.length || a.tokens - b.tokens)
    .slice(0, limit)
}

/**
 * Opens a chart drawn at `w` by `h` design units. Its own size is ten times
 * that, so the pane caps it to its width and scales the height to match: the
 * chart always fills the rail, and grows with it.
 */
const svgOpen = (w: number, h: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 10}" height="${h * 10}" viewBox="0 0 ${w} ${h}" font-family="-apple-system, system-ui, sans-serif">`
const clampWidth = (width = 380) => Math.max(260, Math.min(1400, Math.round(width)))

/** A colour lightened toward white by `amount` (0 to 1). */
export function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(c + (255 - c) * amount)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix)
  return `#${(((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0)).toString(16).padStart(6, '0')}`
}

/** A name cut to `chars`, with an ellipsis when cut. */
function fit(name: string, chars: number): string {
  return name.length <= chars ? name : `${name.slice(0, Math.max(1, chars - 1))}…`
}

export type ShareFile = { name: string; tokens: number }
export type ShareGroup = {
  name: string
  tokens: number
  area: string
  isUsed: boolean
  color?: string
  /** The notes the folder's slice is split into, each hoverable. */
  files?: ShareFile[]
}

/** A donut of the tokens loaded by folder, the latest turn's folders at full strength. */
export function shareSvg(groups: ShareGroup[], width?: number): string {
  const w = clampWidth(width)
  const total = groups.reduce((n, g) => n + g.tokens, 0)
  // Folders that share a colour take lighter shades of it, in order.
  const seen = new Map<string, number>()
  const colorOf = new Map(
    groups.map(g => {
      const base = g.color ?? areaColor(g.area)
      const i = seen.get(base) ?? 0
      seen.set(base, i + 1)
      return [g.name, lighten(base, Math.min(0.6, i * 0.3))]
    }),
  )
  const size = Math.min(w - 60, 300)
  const r = size / 2
  const inner = r * 0.62
  const cx = w / 2
  const cy = r + 10
  const rowH = 24
  const legendTop = cy + r + 22
  const h = legendTop + groups.length * rowH + 6
  let angle = -Math.PI / 2
  const shareTips: Tip[] = []
  const p = (a: number, rad: number) => `${(cx + Math.cos(a) * rad).toFixed(1)} ${(cy + Math.sin(a) * rad).toFixed(1)}`
  /** One ring segment from angle a0 to a1. */
  const segment = (a0: number, a1: number) => {
    if (a1 - a0 >= Math.PI * 2 - 0.02) {
      return `M ${p(-Math.PI / 2, r)} A ${r} ${r} 0 1 1 ${p(Math.PI * 1.4999, r)} L ${p(Math.PI * 1.4999, inner)} A ${inner} ${inner} 0 1 0 ${p(-Math.PI / 2, inner)} Z`
    }
    const big = a1 - a0 > Math.PI ? 1 : 0
    return `M ${p(a0, r)} A ${r} ${r} 0 ${big} 1 ${p(a1, r)} L ${p(a1, inner)} A ${inner} ${inner} 0 ${big} 0 ${p(a0, inner)} Z`
  }
  // Each folder's slice, split into its notes by a hairline in the page's
  // colour; the gap between folders is wider.
  const arcs = groups
    .filter(g => g.tokens > 0)
    .map(g => {
      const sweep = (g.tokens / total) * Math.PI * 2
      const groupStart = angle
      angle += sweep
      const fill = colorOf.get(g.name) ?? areaColor(g.area)
      const opacity = g.isUsed ? 1 : 0.35
      const files = (g.files ?? []).filter(f => f.tokens > 0).sort((a, b) => b.tokens - a.tokens)
      const parts = files.length > 0 ? files : [{ name: g.name, tokens: g.tokens }]
      const partTotal = parts.reduce((n, f) => n + f.tokens, 0) || 1
      const usable = Math.max(0, sweep - 0.012)
      let at = groupStart
      return parts
        .map(f => {
          const fileSweep = (f.tokens / partTotal) * usable
          const a0 = at
          const a1 = at + fileSweep
          at = a1
          const pct = Math.round((f.tokens / total) * 100)
          const id = `s${shareTips.length}`
          const label = files.length > 0 ? `${f.name} · ${g.name}` : g.name
          shareTips.push({ id, x: cx, y: cy, text: `${label} · ${pct}% · ${k(f.tokens)}` })
          return `<path id="i-${id}" d="${segment(a0, a1)}" fill="${fill}" fill-opacity="${opacity}" stroke="#1f1f1e" stroke-width="0.8" stroke-opacity="0.9"></path>`
        })
        .join('')
    })
    .join('')
  const center = `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="26" font-weight="600" fill="#e6e6e6">${k(total)}</text><text x="${cx}" y="${cy + 20}" text-anchor="middle" font-size="13" fill="#8a8a8a">tokens loaded</text>`
  // A key under the donut: colour, folder, share. Data-surface text.
  const legend = groups
    .map((g, i) => {
      const y = legendTop + i * rowH
      const pct = total > 0 ? Math.round((g.tokens / total) * 100) : 0
      const fill = g.isUsed ? '#e6e6e6' : '#8a8a8a'
      return `<rect x="12" y="${y - 11}" width="12" height="12" rx="3" fill="${colorOf.get(g.name) ?? areaColor(g.area)}" fill-opacity="${g.isUsed ? 1 : 0.35}"/><text x="32" y="${y}" font-size="14" fill="${fill}">${escape(g.name)}</text><text x="${w - 12}" y="${y}" text-anchor="end" font-size="14" fill="${fill}">${pct}%</text>`
    })
    .join('')
  return `${svgOpen(w, h)}${arcs}${center}${legend}${tipLayer(shareTips, w, h)}</svg>`
}

export type TimelineRead = { path: string; turn: number; tokens: number; isRepeat: boolean }

/** Turns left to right, each turn's notes stacked by tokens. */
export function timelineSvg(reads: TimelineRead[], latestTurn: number, width?: number): string {
  const w = clampWidth(width)
  const first = Math.max(1, latestTurn - 11)
  const turns = Array.from({ length: latestTurn - first + 1 }, (_, i) => first + i)
  const byTurn = new Map(turns.map(t => [t, reads.filter(r => r.turn === t).sort((a, b) => b.tokens - a.tokens)]))
  const totals = turns.map(t => (byTurn.get(t) ?? []).reduce((n, r) => n + r.tokens, 0))
  const max = Math.max(1, ...totals)
  const h = 230
  const top = 26
  const base = h - 26
  const slot = (w - 24) / turns.length
  const timeTips: Tip[] = []
  const barW = Math.min(44, slot * 0.62)
  const bars = turns
    .map((t, i) => {
      const x = 12 + slot * i + (slot - barW) / 2
      let y = base
      const isNow = t === latestTurn
      const segs = (byTurn.get(t) ?? [])
        .map(r => {
          const hh = Math.max(2, (r.tokens / max) * (base - top))
          y -= hh
          const id = `l${timeTips.length}`
          timeTips.push({
            id,
            x: x + barW / 2,
            y: y + hh / 2,
            text: `${noteName(r.path)} · ${k(r.tokens)}${r.isRepeat ? ' · read again' : ''}`,
          })
          return `<rect id="i-${id}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(hh - 1).toFixed(1)}" rx="2" fill="${noteColor(r.path)}" fill-opacity="${isNow ? 1 : 0.4}"${r.isRepeat ? ' stroke="#e6e6e6" stroke-dasharray="3 2" stroke-width="1"' : ''}></rect>`
        })
        .join('')
      const total = totals[i] ?? 0
      const head = total > 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="12.5" fill="${isNow ? '#e6e6e6' : '#8a8a8a'}">${k(total)}</text>` : ''
      const foot = `<text x="${(x + barW / 2).toFixed(1)}" y="${base + 16}" text-anchor="middle" font-size="13" fill="${isNow ? '#e6e6e6' : '#8a8a8a'}"${isNow ? ' font-weight="600"' : ''}>${t}</text>`
      return segs + head + foot
    })
    .join('')
  const axis = `<line x1="12" y1="${base}" x2="${w - 12}" y2="${base}" stroke="#8a8a8a" stroke-opacity="0.4"/>`
  return `${svgOpen(w, h)}${axis}${bars}${tipLayer(timeTips, w, h)}</svg>`
}

export type TreemapNote = { path: string; tokens: number; isLatest: boolean }

type Rect = { x: number; y: number; w: number; h: number }

/** Splits a rectangle between items by weight, along its longer side. */
function split<T>(items: T[], weight: (t: T) => number, r: Rect): [T, Rect][] {
  const total = items.reduce((n, t) => n + weight(t), 0) || 1
  let offset = 0
  return items.map(t => {
    const share = weight(t) / total
    const along = r.w >= r.h
    const cell = along
      ? { x: r.x + offset * r.w, y: r.y, w: share * r.w, h: r.h }
      : { x: r.x, y: r.y + offset * r.h, w: r.w, h: share * r.h }
    offset += share
    return [t, cell]
  })
}

/** Areas, then their notes, as rectangles sized by tokens. */
export function treemapSvg(notes: TreemapNote[], width?: number): string {
  const w = clampWidth(width)
  const h = Math.round(Math.max(220, Math.min(560, w * 0.75)))
  const areas = new Map<string, TreemapNote[]>()
  for (const n of notes.filter(n => n.tokens > 0)) areas.set(areaOf(n.path), [...(areas.get(areaOf(n.path)) ?? []), n])
  const areaList = [...areas.entries()]
    .map(([area, list]) => ({ area, list: list.sort((a, b) => b.tokens - a.tokens), tokens: list.reduce((n, x) => n + x.tokens, 0) }))
    .sort((a, b) => b.tokens - a.tokens)
  const treeTips: Tip[] = []
  const cells = split(areaList, a => a.tokens, { x: 0, y: 0, w, h })
    .map(([a, r]) => {
      const inner = { x: r.x + 2, y: r.y + 2, w: Math.max(0, r.w - 4), h: Math.max(0, r.h - 4) }
      // Files split the other way from their area, so long thin strips are rarer.
      const notesIn = split(a.list, n => n.tokens, inner.w >= inner.h ? { ...inner, w: inner.w, h: inner.h } : inner)
      return notesIn
        .map(([n, c]) => {
          const full = noteName(n.path)
          const chars = Math.floor((c.w - 14) / 7.3)
          const fitsName = chars >= 4 && c.h > 20
          const name = fit(full, chars)
          const fitsSize = fitsName && c.h > 38
          const fill = n.isLatest ? '#f2f2f2' : '#cfcfcf'
          const id = `r${treeTips.length}`
          treeTips.push({ id, x: c.x + c.w / 2, y: c.y + c.h / 2, text: `${full} · ${k(n.tokens)}` })
          return `<g><rect id="i-${id}" x="${(c.x + 1).toFixed(1)}" y="${(c.y + 1).toFixed(1)}" width="${Math.max(0, c.w - 2).toFixed(1)}" height="${Math.max(0, c.h - 2).toFixed(1)}" rx="3" fill="${noteColor(n.path)}" fill-opacity="${n.isLatest ? 0.9 : 0.35}"/>${fitsName ? `<text x="${(c.x + 7).toFixed(1)}" y="${(c.y + 16).toFixed(1)}" font-size="13" fill="${fill}"${n.isLatest ? ' font-weight="600"' : ''}>${escape(name)}</text>` : ''}${fitsSize ? `<text x="${(c.x + 7).toFixed(1)}" y="${(c.y + 31).toFixed(1)}" font-size="12" fill="${fill}" fill-opacity="0.8">${k(n.tokens)}</text>` : ''}</g>`
        })
        .join('')
    })
    .join('')
  return `${svgOpen(w, h)}${cells}${tipLayer(treeTips, w, h)}</svg>`
}

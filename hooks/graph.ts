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
export function areaColor(area: string): string {
  return AREA_COLORS[area] ?? '#888780'
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
  const rim = Math.max(80, Math.min(w / 2 - 74, height / 2 - 22))
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
  const usedSet = new Set(used.map(n => n.path))

  // Notes linked to what was loaded but not loaded themselves, the most
  // linked first.
  const ghostScore = new Map<string, number>()
  if (index) {
    for (const n of used) {
      for (const other of index.links.get(n.path) ?? []) {
        if (!usedSet.has(other)) ghostScore.set(other, (ghostScore.get(other) ?? 0) + 1)
      }
    }
  }
  const ghosts = [...ghostScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([path]) => ({ path, tokens: index?.tokens.get(path) ?? 0, turn: 0 }))

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
      const label = area === 'root' ? 'vault root' : area
      const w = label.length * 7.2
      const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2
      rimBoxes.push({ x0, x1: x0 + w, y0: y - 12, y1: y + 3 })
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="13" fill="${areaColor(area)}" fill-opacity="${isPresent ? 0.95 : 0.35}">${area === 'root' ? 'vault root' : area}</text>`
    })
    .join('')

  const circles = nodes
    .sort((a, b) => (a.turn === 0 ? -1 : 0) - (b.turn === 0 ? -1 : 0) || b.tokens - a.tokens)
    .map(n => {
      const isNow = isLatest(n)
      const isFocus = n.path === focus
      const color = areaColor(areaOf(n.path))
      const cx = n.x.toFixed(1)
      const cy = n.y.toFixed(1)
      const r = radius(n)
      const tip =
        n.turn === 0
          ? `${noteName(n.path)}: linked, not loaded`
          : `${noteName(n.path)}: ${k(n.tokens)} tokens, read in turn ${n.turn}${isNow ? ' (latest)' : ''}`
      // A soft halo marks what the latest turn used.
      const halo = isNow
        ? `<circle cx="${cx}" cy="${cy}" r="${(r + 5 * f.scale).toFixed(1)}" fill="${color}" fill-opacity="0.22"/>`
        : ''
      const ring = isFocus ? ` stroke="#ffffff" stroke-width="2" stroke-opacity="0.95"` : ''
      return `<g><title>${escape(tip)}</title>${halo}<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="${color}" fill-opacity="${opacity(n)}"${ring}/></g>`
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
      const w = name.length * 6.2
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
          ? `<text x="${spot.x.toFixed(1)}" y="${spot.y.toFixed(1)}" text-anchor="${spot.anchor}" font-size="11.5" font-weight="600" fill="#e6e6e6">${escape(name)}</text>`
          : `<text x="${spot.x.toFixed(1)}" y="${spot.y.toFixed(1)}" text-anchor="${spot.anchor}" font-size="11" fill="#8a8a8a" fill-opacity="0.8">${escape(name)}</text>`,
      ]
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}" font-family="-apple-system, system-ui, sans-serif">${edges.join('')}${circles}${labels}${rim}</svg>`
}

import dagre from '@dagrejs/dagre';
import type { DatabaseModel, ForeignKey } from '../../../../../shared/models';

export const HEADER_H = 30;
export const ROW_H = 20;
export const PAD_X = 12;
/** Columns shown per table; the rest is summed up in one line. */
export const MAX_COLUMNS = 25;
const MIN_W = 140;
const MAX_W = 420;
const GAP = 48;

export interface ErColumn {
  name: string;
  type: string;
  primary: boolean;
  foreign: boolean;
}

export interface ErNode {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: ErColumn[];
  /** Columns not drawn (past MAX_COLUMNS). */
  hidden: number;
}

export interface ErEdge {
  key: ForeignKey;
  from: string;
  to: string;
  /** SVG path from the key column (many) to the referenced column (one). */
  path: string;
  /** End points, for the crow's foot and the bar. */
  start: { x: number; y: number; dir: 1 | -1 };
  end: { x: number; y: number; dir: 1 | -1 };
}

export interface ErLayout {
  nodes: ErNode[];
  edges: ErEdge[];
  width: number;
  height: number;
}

/** Width of a text in pixels (canvas in the app, an estimate in tests). */
export type Measure = (text: string, bold?: boolean) => number;

/**
 * Places the tables of a database: related tables left to right by their keys (dagre), tables
 * without relations in a grid below them. Lines go from the key column to the referenced column.
 */
export function layoutModel(model: DatabaseModel, database: string, measure: Measure): ErLayout {
  const inDb = new Set(model.tables.map((t) => t.name));
  const keys = model.foreignKeys.filter(
    (k) =>
      k.database === database &&
      k.refDatabase === database &&
      inDb.has(k.table) &&
      inDb.has(k.refTable),
  );
  const foreignCols = new Map<string, Set<string>>();
  for (const k of keys) {
    const set = foreignCols.get(k.table) ?? new Set<string>();
    for (const c of k.columns) set.add(c);
    foreignCols.set(k.table, set);
  }

  const sized = model.tables.map((t) => {
    const foreign = foreignCols.get(t.name) ?? new Set<string>();
    const columns: ErColumn[] = t.columns.slice(0, MAX_COLUMNS).map((c) => ({
      ...c,
      foreign: foreign.has(c.name),
    }));
    const hidden = Math.max(0, t.columns.length - MAX_COLUMNS);
    const widest = Math.max(
      measure(t.name, true) + 2 * PAD_X,
      ...columns.map((c) => measure(c.name) + measure(c.type) + 2 * PAD_X + 34),
    );
    const width = Math.round(Math.min(MAX_W, Math.max(MIN_W, widest)));
    const height = HEADER_H + (columns.length + (hidden ? 1 : 0)) * ROW_H + 8;
    return { name: t.name, columns, hidden, width, height };
  });

  const related = new Set(keys.flatMap((k) => [k.table, k.refTable]));
  const nodes: ErNode[] = [];
  let width = 0;
  let height = 0;

  // Related tables: layered, referenced tables to the right of the tables that point to them.
  const linked = sized.filter((t) => related.has(t.name));
  if (linked.length) {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: 'RL', nodesep: 32, ranksep: 110, marginx: GAP / 2, marginy: GAP / 2 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const t of linked) g.setNode(t.name, { width: t.width, height: t.height });
    for (const k of keys) if (k.table !== k.refTable) g.setEdge(k.refTable, k.table, {}, k.name);
    dagre.layout(g);
    for (const t of linked) {
      const n = g.node(t.name);
      nodes.push({ ...t, x: Math.round(n.x - t.width / 2), y: Math.round(n.y - t.height / 2) });
    }
    const graph = g.graph();
    width = graph.width ?? 0;
    height = graph.height ?? 0;
  }

  // The rest in rows below, as wide as the related part (or a sensible width).
  const loose = sized.filter((t) => !related.has(t.name));
  if (loose.length) {
    const rowWidth = Math.max(width, 1200);
    let x = GAP / 2;
    let y = height + (height ? GAP : GAP / 2);
    let rowHeight = 0;
    for (const t of loose) {
      if (x + t.width > rowWidth && x > GAP / 2) {
        x = GAP / 2;
        y += rowHeight + GAP / 2;
        rowHeight = 0;
      }
      nodes.push({ ...t, x, y });
      x += t.width + GAP / 2;
      rowHeight = Math.max(rowHeight, t.height);
      width = Math.max(width, x);
    }
    height = y + rowHeight + GAP / 2;
  }

  const byName = new Map(nodes.map((n) => [n.name, n]));
  const rowY = (n: ErNode, column: string) => {
    const i = n.columns.findIndex((c) => c.name === column);
    return n.y + HEADER_H + (i < 0 ? 0 : i) * ROW_H + ROW_H / 2 + 2;
  };
  const edges: ErEdge[] = [];
  for (const key of keys) {
    const from = byName.get(key.table);
    const to = byName.get(key.refTable);
    if (!from || !to) continue;
    const y1 = rowY(from, key.columns[0]!);
    const y2 = rowY(to, key.refColumns[0]!);
    let path: string;
    let start: ErEdge['start'];
    let end: ErEdge['end'];
    if (from === to) {
      // A key to its own table: a loop on the right side.
      const x = from.x + from.width;
      start = { x, y: y1, dir: 1 };
      end = { x, y: y2, dir: 1 };
      path = `M${x},${y1} C${x + 50},${y1} ${x + 50},${y2} ${x},${y2}`;
    } else {
      const toRight = to.x + to.width / 2 >= from.x + from.width / 2;
      const x1 = toRight ? from.x + from.width : from.x;
      const x2 = toRight ? to.x : to.x + to.width;
      const d = Math.max(40, Math.abs(x2 - x1) / 2);
      const s = toRight ? 1 : -1;
      start = { x: x1, y: y1, dir: s };
      end = { x: x2, y: y2, dir: s === 1 ? -1 : 1 };
      path = `M${x1},${y1} C${x1 + s * d},${y1} ${x2 - s * d},${y2} ${x2},${y2}`;
    }
    edges.push({ key, from: key.table, to: key.refTable, path, start, end });
  }
  return { nodes, edges, width: Math.ceil(width), height: Math.ceil(height) };
}

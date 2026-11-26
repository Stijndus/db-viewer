import type { GridCell } from './data-grid';

/** How a cell shows in the grid and the row detail: text, a style class and a tooltip. */
export interface CellView {
  text: string;
  cls: string;
  title: string | null;
}

export function viewOf(cell: GridCell): CellView {
  if (cell === null) return { text: 'NULL', cls: 'is-null', title: null };
  if (typeof cell === 'object' && cell.kind === 'default') {
    return { text: 'DEFAULT', cls: 'is-default', title: 'Krijgt de standaardwaarde van de kolom' };
  }
  if (typeof cell === 'object' && cell.kind === 'sql') {
    return {
      text: cell.label ?? cell.sql,
      cls: 'is-sql',
      title: `Wordt bij opslaan: ${cell.sql.slice(0, 200)}`,
    };
  }
  if (typeof cell === 'string') {
    if (cell === '') return { text: "''", cls: 'is-empty', title: 'Lege tekst' };
    return { text: cell, cls: '', title: cell.length > 30 ? cell.slice(0, 500) : null };
  }
  if (cell.kind === 'binary') {
    const more = cell.bytes * 2 > cell.hex.length ? '…' : '';
    return {
      text: `0x${cell.hex.toUpperCase()}${more}`,
      cls: 'is-binary',
      title: `Binair, ${cell.bytes} ${cell.bytes === 1 ? 'byte' : 'bytes'}`,
    };
  }
  return {
    text: cell.text,
    cls: 'is-truncated',
    title: `Lange tekst: ${cell.length.toLocaleString('nl-NL')} tekens, eerste ${cell.text.length.toLocaleString('nl-NL')} getoond`,
  };
}

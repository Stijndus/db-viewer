/**
 * Every command that can have a key, and the default keys. The defaults follow HeidiSQL, except
 * where DB Viewer already had its own key (those stay, HeidiSQL's is added when it is free), plus
 * a few from VS Code for things HeidiSQL does not have (command palette, keyboard shortcuts).
 *
 * Contexts for `when`:
 *   connected     a connection is open (the workspace is shown)
 *   tableTab      the active tab shows a table or view
 *   sqlTab        the active tab is a SQL editor
 *   editorFocus   the focus is in the SQL editor
 *   gridFocus     the focus is in a data grid (not in a cell being edited)
 *   treeFocus     the focus is in the schema tree (not in its filter)
 *   inputFocus    the focus is in a text field (filter, cell editor, …), not the SQL editor
 */

export interface CommandInfo {
  id: string;
  title: string;
  category: string;
}

export type BindingSource = 'HeidiSQL' | 'DB Viewer' | 'VS Code';

export interface Keybinding {
  key: string;
  command: string;
  when?: string;
}

export interface DefaultBinding extends Keybinding {
  source: BindingSource;
}

export const COMMANDS: CommandInfo[] = [
  // Algemeen
  { id: 'workbench.commandPalette', title: 'Opdrachtenpalet', category: 'Algemeen' },
  { id: 'workbench.keybindings', title: 'Sneltoetsen', category: 'Algemeen' },
  { id: 'workbench.theme', title: 'Thema kiezen', category: 'Algemeen' },
  { id: 'workbench.zoomIn', title: 'Inzoomen', category: 'Algemeen' },
  { id: 'workbench.zoomOut', title: 'Uitzoomen', category: 'Algemeen' },
  { id: 'workbench.zoomReset', title: 'Zoom op 100%', category: 'Algemeen' },
  // Tabbladen
  { id: 'tabs.newSql', title: 'Nieuw SQL-tabblad', category: 'Tabbladen' },
  { id: 'tabs.close', title: 'Tabblad sluiten', category: 'Tabbladen' },
  { id: 'tabs.next', title: 'Volgend tabblad', category: 'Tabbladen' },
  { id: 'tabs.previous', title: 'Vorig tabblad', category: 'Tabbladen' },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `tabs.goTo${i + 1}`,
    title: `Naar tabblad ${i + 1}`,
    category: 'Tabbladen',
  })),
  // Schema
  { id: 'tree.focus', title: 'Naar de databaseboom', category: 'Schema' },
  { id: 'tree.focusFilter', title: 'Tabellen filteren', category: 'Schema' },
  { id: 'tree.refresh', title: 'Schema vernieuwen', category: 'Schema' },
  { id: 'tree.emptyTable', title: 'Tabel leegmaken…', category: 'Schema' },
  // SQL
  {
    id: 'sql.runCurrent',
    title: 'Statement onder de cursor of selectie uitvoeren',
    category: 'SQL',
  },
  { id: 'sql.runAll', title: 'Alles uitvoeren', category: 'SQL' },
  { id: 'sql.stop', title: 'Uitvoeren stoppen', category: 'SQL' },
  { id: 'sql.clear', title: 'Editor leegmaken', category: 'SQL' },
  { id: 'sql.previousResult', title: 'Vorig resultaat', category: 'SQL' },
  { id: 'sql.nextResult', title: 'Volgend resultaat', category: 'SQL' },
  // SQL-editor
  { id: 'editor.find', title: 'Zoeken', category: 'SQL-editor' },
  { id: 'editor.replace', title: 'Vervangen', category: 'SQL-editor' },
  { id: 'editor.findNext', title: 'Volgende zoeken', category: 'SQL-editor' },
  { id: 'editor.findPrevious', title: 'Vorige zoeken', category: 'SQL-editor' },
  { id: 'editor.deleteLine', title: 'Regel verwijderen', category: 'SQL-editor' },
  { id: 'editor.matchBracket', title: 'Naar bijbehorend haakje', category: 'SQL-editor' },
  { id: 'editor.upperCase', title: 'Hoofdletters', category: 'SQL-editor' },
  { id: 'editor.lowerCase', title: 'Kleine letters', category: 'SQL-editor' },
  { id: 'editor.toggleComment', title: 'Commentaar aan/uit', category: 'SQL-editor' },
  // Data
  { id: 'data.refresh', title: 'Data vernieuwen', category: 'Data' },
  { id: 'data.save', title: 'Wijzigingen opslaan', category: 'Data' },
  { id: 'data.addRow', title: 'Rij toevoegen', category: 'Data' },
  { id: 'data.deleteRows', title: 'Rij verwijderen', category: 'Data' },
  { id: 'data.setNull', title: 'Cel op NULL zetten', category: 'Data' },
  { id: 'data.focusFilter', title: 'Naar het filter (WHERE)', category: 'Data' },
  { id: 'data.clearFilter', title: 'Filter leegmaken', category: 'Data' },
  { id: 'data.resetSort', title: 'Sortering herstellen', category: 'Data' },
  { id: 'data.nextPage', title: 'Volgende pagina', category: 'Data' },
  { id: 'data.previousPage', title: 'Vorige pagina', category: 'Data' },
  { id: 'data.copy', title: 'Kopiëren', category: 'Data' },
  { id: 'data.paste', title: 'Plakken', category: 'Data' },
  { id: 'data.find', title: 'Zoeken in het grid', category: 'Data' },
  { id: 'data.sqlFunction', title: 'SQL-functie in cel…', category: 'Data' },
  { id: 'data.duplicateRow', title: 'Rij dupliceren zonder sleutels', category: 'Data' },
  { id: 'data.discard', title: 'Wijzigingen annuleren', category: 'Data' },
  { id: 'data.selectAll', title: 'Alles selecteren', category: 'Data' },
  { id: 'data.exportRows', title: 'Rijen exporteren naar klembord…', category: 'Data' },
];

const H: BindingSource = 'HeidiSQL';
const D: BindingSource = 'DB Viewer';
const V: BindingSource = 'VS Code';

export const DEFAULT_BINDINGS: DefaultBinding[] = [
  { key: 'ctrl+shift+p', command: 'workbench.commandPalette', source: V },
  { key: 'f1', command: 'workbench.commandPalette', source: V },
  { key: 'ctrl+k ctrl+s', command: 'workbench.keybindings', source: V },
  { key: 'ctrl+k ctrl+t', command: 'workbench.theme', source: D },
  { key: 'ctrl+=', command: 'workbench.zoomIn', source: D },
  { key: 'ctrl+shift+=', command: 'workbench.zoomIn', source: D },
  { key: 'ctrl+numpad_add', command: 'workbench.zoomIn', source: D },
  { key: 'ctrl+-', command: 'workbench.zoomOut', source: D },
  { key: 'ctrl+numpad_subtract', command: 'workbench.zoomOut', source: D },
  { key: 'ctrl+0', command: 'workbench.zoomReset', source: D },

  { key: 'ctrl+t', command: 'tabs.newSql', when: 'connected', source: H },
  { key: 'ctrl+f4', command: 'tabs.close', when: 'connected', source: H },
  { key: 'ctrl+tab', command: 'tabs.next', when: 'connected', source: H },
  { key: 'ctrl+shift+tab', command: 'tabs.previous', when: 'connected', source: H },
  ...Array.from({ length: 9 }, (_, i) => ({
    key: `ctrl+${i + 1}`,
    command: `tabs.goTo${i + 1}`,
    when: 'connected',
    source: H,
  })),

  { key: 'ctrl+d', command: 'tree.focus', when: 'connected', source: H },
  { key: 'ctrl+e', command: 'tree.focusFilter', when: 'connected', source: H },
  { key: 'f5', command: 'tree.refresh', when: 'treeFocus || connected && !tableTab', source: H },
  { key: 'delete', command: 'tree.emptyTable', when: 'treeFocus', source: H },

  { key: 'ctrl+enter', command: 'sql.runCurrent', when: 'sqlTab', source: D },
  { key: 'ctrl+shift+f9', command: 'sql.runCurrent', when: 'sqlTab', source: H },
  { key: 'ctrl+f9', command: 'sql.runCurrent', when: 'sqlTab', source: H },
  { key: 'ctrl+shift+enter', command: 'sql.runAll', when: 'sqlTab', source: D },
  { key: 'f9', command: 'sql.runAll', when: 'sqlTab', source: H },
  { key: 'escape', command: 'sql.stop', when: 'sqlTab', source: H },
  { key: 'ctrl+w', command: 'sql.clear', when: 'editorFocus', source: H },
  { key: 'alt+arrowleft', command: 'sql.previousResult', when: 'sqlTab', source: H },
  { key: 'alt+arrowright', command: 'sql.nextResult', when: 'sqlTab', source: H },

  { key: 'ctrl+f', command: 'editor.find', when: 'editorFocus', source: H },
  { key: 'ctrl+r', command: 'editor.replace', when: 'editorFocus', source: H },
  { key: 'f3', command: 'editor.findNext', when: 'editorFocus', source: H },
  { key: 'shift+f3', command: 'editor.findPrevious', when: 'editorFocus', source: H },
  { key: 'ctrl+y', command: 'editor.deleteLine', when: 'editorFocus', source: H },
  { key: 'ctrl+shift+b', command: 'editor.matchBracket', when: 'editorFocus', source: H },
  { key: 'ctrl+u', command: 'editor.upperCase', when: 'editorFocus', source: H },
  { key: 'ctrl+l', command: 'editor.lowerCase', when: 'editorFocus', source: H },
  { key: 'ctrl+/', command: 'editor.toggleComment', when: 'editorFocus', source: V },

  { key: 'f5', command: 'data.refresh', when: 'tableTab && !treeFocus', source: H },
  { key: 'ctrl+s', command: 'data.save', when: 'tableTab', source: D },
  { key: 'ctrl+enter', command: 'data.save', when: 'tableTab', source: H },
  {
    key: 'insert',
    command: 'data.addRow',
    when: 'tableTab && !inputFocus && !treeFocus',
    source: H,
  },
  { key: 'ctrl+delete', command: 'data.deleteRows', when: 'gridFocus', source: H },
  { key: 'ctrl+shift+n', command: 'data.setNull', when: 'gridFocus', source: H },
  { key: 'ctrl+alt+f', command: 'data.focusFilter', when: 'tableTab', source: H },
  { key: 'ctrl+w', command: 'data.clearFilter', when: 'tableTab && !editorFocus', source: H },
  { key: 'alt+s', command: 'data.resetSort', when: 'tableTab', source: H },
  { key: 'ctrl+alt+pagedown', command: 'data.nextPage', when: 'tableTab', source: H },
  { key: 'ctrl+alt+pageup', command: 'data.previousPage', when: 'tableTab', source: H },
  { key: 'ctrl+c', command: 'data.copy', when: 'gridFocus', source: H },
  { key: 'ctrl+v', command: 'data.paste', when: 'gridFocus', source: H },
  { key: 'ctrl+f', command: 'data.find', when: 'gridFocus', source: H },
  { key: 'ctrl+f2', command: 'data.sqlFunction', when: 'gridFocus', source: H },
  {
    key: 'ctrl+insert',
    command: 'data.duplicateRow',
    when: 'tableTab && !inputFocus && !treeFocus',
    source: H,
  },
  { key: 'ctrl+a', command: 'data.selectAll', when: 'gridFocus', source: H },
  { key: 'ctrl+shift+c', command: 'data.exportRows', when: 'gridFocus', source: H },
];

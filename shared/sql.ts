/**
 * SQL helpers shared by the editor (statement under the cursor, confirmations) and the main process
 * (enforcing read-only connections). They know each dialect's quotes and comments, MySQL's
 * client-side DELIMITER, PostgreSQL's dollar quoting and SQL Server's GO, but are not a parser.
 */
import type { DbType } from './models';

export interface SqlStatement {
  /** Statement text without its delimiter, trimmed. */
  sql: string;
  /** Offsets of `sql` in the original text. */
  from: number;
  to: number;
}

/** Splits a script into statements on `;` (or DELIMITER / GO), outside quotes and comments. */
export function splitStatements(text: string, dialect: DbType = 'mysql'): SqlStatement[] {
  const out: SqlStatement[] = [];
  const lexer = new Lexer(text, dialect);
  let delimiter = ';';
  let start = 0; // start of the current statement segment
  let hasContent = false; // the segment holds something other than whitespace and comments

  const push = (end: number) => {
    if (hasContent) {
      const raw = text.slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      const sql = raw.trim();
      out.push({ sql, from: start + lead, to: start + lead + sql.length });
    }
    hasContent = false;
  };

  while (lexer.i < text.length) {
    const i = lexer.i;
    const ch = text[i]!;

    // DELIMITER is a MySQL client command; only recognised at the start of a statement.
    if (dialect === 'mysql' && !hasContent && (ch === 'd' || ch === 'D') && atLineStart(text, i)) {
      const match = /^delimiter[ \t]+(\S+)[^\n]*/i.exec(text.slice(i));
      if (match) {
        delimiter = match[1]!;
        lexer.i += match[0].length;
        start = lexer.i;
        continue;
      }
    }
    // GO (optionally with a count) alone on a line ends a batch in SQL Server tools.
    if (dialect === 'mssql' && (ch === 'g' || ch === 'G') && atLineStart(text, i)) {
      const match = /^go(?:[ \t]+\d+)?[ \t]*(?=\r?\n|$)/i.exec(text.slice(i));
      if (match) {
        push(i);
        lexer.i += match[0].length;
        start = lexer.i;
        continue;
      }
    }

    const token = lexer.next();
    if (token === 'comment') continue;
    if (token === 'code-comment' || token === 'quoted') {
      hasContent = true;
      continue;
    }
    // A plain character: lexer.next() did not move.
    if (text.startsWith(delimiter, i)) {
      push(i);
      lexer.i = i + delimiter.length;
      start = lexer.i;
      continue;
    }
    if (!/\s/.test(ch)) hasContent = true;
    lexer.i = i + 1;
  }
  push(text.length);
  return out;
}

/** The statement the cursor is in: the last one that starts at or before it. */
export function statementAt(statements: SqlStatement[], cursor: number): SqlStatement | null {
  let found: SqlStatement | null = null;
  for (const s of statements) {
    if (s.from <= cursor) found = s;
    else break;
  }
  return found ?? statements[0] ?? null;
}

/** `unknown`: not a statement we recognise (often a typo); the server decides. */
export type StatementKind = 'read' | 'write' | 'session' | 'unknown';

export interface StatementInfo {
  kind: StatementKind;
  /** First keyword, upper case, e.g. `SELECT`. */
  keyword: string;
  /** An UPDATE or DELETE without WHERE: it touches every row. */
  unbounded: boolean;
}

const READ = new Set([
  'SELECT',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
  'TABLE',
  'VALUES',
  'HELP',
  'WITH',
]);
const SESSION = new Set([
  'USE',
  'SET',
  'BEGIN',
  'START',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'DO',
  // PostgreSQL
  'END',
  'ABORT',
  'DISCARD',
  'LISTEN',
  'UNLISTEN',
  'DEALLOCATE',
  'FETCH',
  'MOVE',
  'CLOSE',
  // SQL Server
  'DECLARE',
  'PRINT',
  'SAVE',
  'WAITFOR',
  'RAISERROR',
  'THROW',
  // SQLite
  'PRAGMA',
  'ATTACH',
  'DETACH',
]);
const WRITE = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'MERGE',
  'UPSERT',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'GRANT',
  'REVOKE',
  'DENY',
  'CALL',
  'LOAD',
  'HANDLER',
  'LOCK',
  'UNLOCK',
  'OPTIMIZE',
  'ANALYZE',
  'REPAIR',
  'FLUSH',
  'KILL',
  'RESET',
  'PURGE',
  'INSTALL',
  'UNINSTALL',
  'IMPORT',
  'CLONE',
  'SHUTDOWN',
  'RESTART',
  'CHANGE',
  'XA',
  'PREPARE',
  'EXECUTE',
  'EXEC',
  'CACHE',
  // PostgreSQL
  'COPY',
  'VACUUM',
  'REINDEX',
  'CLUSTER',
  'COMMENT',
  'SECURITY',
  'REFRESH',
  'REASSIGN',
  'NOTIFY',
  'CHECKPOINT',
  // SQL Server
  'BACKUP',
  'RESTORE',
  'DBCC',
  'BULK',
  'ENABLE',
  'DISABLE',
  'UPDATETEXT',
  'WRITETEXT',
]);
const WRITE_IN_WITH = new Set(['UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'MERGE']);

export function classify(sql: string, dialect: DbType = 'mysql'): StatementInfo {
  const words = topLevelWords(sql, dialect);
  const keyword = words[0] ?? '';
  let kind: StatementKind = READ.has(keyword)
    ? 'read'
    : SESSION.has(keyword)
      ? 'session'
      : WRITE.has(keyword)
        ? 'write'
        : 'unknown';

  // PostgreSQL DO runs an anonymous code block, which can change anything.
  if (keyword === 'DO' && dialect === 'postgres') kind = 'write';
  if (keyword === 'WITH' && words.some((w) => WRITE_IN_WITH.has(w))) kind = 'write';
  // EXPLAIN ANALYZE really runs the statement.
  if (keyword === 'EXPLAIN' && words.includes('ANALYZE') && words.some((w) => WRITE_IN_WITH.has(w)))
    kind = 'write';
  if (keyword === 'SELECT' || keyword === 'WITH') {
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] !== 'INTO') continue;
      const target = words[i + 1];
      // MySQL: INTO OUTFILE / DUMPFILE writes a file (INTO @var only sets variables).
      if (dialect === 'mysql' && (target === 'OUTFILE' || target === 'DUMPFILE')) kind = 'write';
      // PostgreSQL and SQL Server: SELECT ... INTO creates a table.
      if (dialect === 'postgres' || dialect === 'mssql') kind = 'write';
    }
  }
  const effective =
    keyword === 'WITH' ? (words.find((w) => WRITE_IN_WITH.has(w)) ?? keyword) : keyword;
  const unbounded = (effective === 'UPDATE' || effective === 'DELETE') && !words.includes('WHERE');
  return { kind, keyword, unbounded };
}

/**
 * Why a statement may not run on a read-only connection, or null when it may. Besides writes,
 * this blocks the ways to switch the session back to read-write.
 */
export function readOnlyViolation(sql: string, dialect: DbType = 'mysql'): string | null {
  const info = classify(sql, dialect);
  if (info.kind === 'write') return `${info.keyword || 'Dit statement'} wijzigt gegevens.`;
  const words = topLevelWords(sql, dialect);
  const text = stripComments(sql, dialect);

  if (dialect === 'mssql' && info.kind === 'unknown') {
    // SQL Server has no read-only session: only statements we recognise as harmless may run.
    return 'Op een alleen-lezen SQL Server-verbinding kunnen alleen lees-statements worden uitgevoerd.';
  }

  let touchesAccessMode = false;
  if (dialect === 'mysql') {
    touchesAccessMode =
      (info.keyword === 'SET' &&
        (words.includes('TRANSACTION') ||
          /\b(transaction_read_only|tx_read_only)\b/i.test(text))) ||
      (info.keyword === 'START' && words.includes('WRITE'));
  }
  if (dialect === 'postgres') {
    touchesAccessMode =
      /\b(default_transaction_read_only|transaction_read_only)\b/i.test(text) ||
      /\bread\s+write\b/i.test(text) ||
      (info.keyword === 'SET' && words.includes('CHARACTERISTICS'));
  }
  if (dialect === 'sqlite') {
    touchesAccessMode = info.keyword === 'PRAGMA' && /\bquery_only\b/i.test(text);
  }
  return touchesAccessMode ? 'De alleen-lezen-modus kan niet worden uitgezet.' : null;
}

/** Keywords and bare identifiers outside quotes, comments and parentheses, upper-cased. */
export function topLevelWords(sql: string, dialect: DbType = 'mysql'): string[] {
  const words: string[] = [];
  const lexer = new Lexer(sql, dialect);
  let depth = 0;
  while (lexer.i < sql.length) {
    const i = lexer.i;
    const ch = sql[i]!;
    // MySQL executable comment (/*!...*/): read its contents as SQL.
    if (dialect === 'mysql' && ch === '/' && sql[i + 1] === '*' && sql[i + 2] === '!') {
      lexer.i = i + 3;
      continue;
    }
    if (lexer.next() !== 'char') continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))!;
      if (depth === 0 || words.length === 0) words.push(match[0].toUpperCase());
      lexer.i = i + match[0].length;
      continue;
    }
    lexer.i = i + 1;
  }
  return words;
}

/** Removes comments (keeps strings), for keyword checks on the remaining text. */
function stripComments(sql: string, dialect: DbType): string {
  let out = '';
  const lexer = new Lexer(sql, dialect);
  while (lexer.i < sql.length) {
    const i = lexer.i;
    const token = lexer.next();
    if (token === 'comment') out += ' ';
    else if (token === 'char') {
      out += sql[i];
      lexer.i = i + 1;
    } else out += sql.slice(i, lexer.i);
  }
  return out;
}

/**
 * Steps over comments and quoted strings/identifiers in one dialect. `next()` consumes one of those
 * and says what it was, or returns 'char' without moving for anything else.
 */
class Lexer {
  i = 0;
  constructor(
    private readonly text: string,
    private readonly dialect: DbType,
  ) {}

  next(): 'comment' | 'code-comment' | 'quoted' | 'char' {
    const { text, dialect } = this;
    const i = this.i;
    const ch = text[i]!;
    const next = text[i + 1];

    // MySQL needs whitespace after "--"; the others don't.
    if (ch === '-' && next === '-' && (dialect !== 'mysql' || /\s/.test(text[i + 2] ?? '\n'))) {
      this.i = skipLine(text, i);
      return 'comment';
    }
    if (ch === '#' && dialect === 'mysql') {
      this.i = skipLine(text, i);
      return 'comment';
    }
    if (ch === '/' && next === '*') {
      this.i = skipBlockComment(text, i, dialect === 'postgres' || dialect === 'mssql');
      return dialect === 'mysql' && text[i + 2] === '!' ? 'code-comment' : 'comment';
    }
    if (ch === "'") {
      // PostgreSQL E'...' strings use backslash escapes; MySQL strings always do.
      const escapeStr =
        dialect === 'mysql' ||
        (dialect === 'postgres' && /[eE]/.test(text[i - 1] ?? '') && !/\w/.test(text[i - 2] ?? ''));
      this.i = skipQuoted(text, i, "'", escapeStr);
      return 'quoted';
    }
    if (ch === '"') {
      this.i = skipQuoted(text, i, '"', dialect === 'mysql');
      return 'quoted';
    }
    if (ch === '`' && (dialect === 'mysql' || dialect === 'sqlite')) {
      this.i = skipQuoted(text, i, '`', false);
      return 'quoted';
    }
    if (ch === '[' && (dialect === 'mssql' || dialect === 'sqlite')) {
      this.i = skipQuoted(text, i, ']', false);
      return 'quoted';
    }
    if (ch === '$' && dialect === 'postgres') {
      // Dollar quoting: $$...$$ or $tag$...$tag$ (not $1 parameters).
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tag && !/[\w$]/.test(text[i - 1] ?? '')) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        this.i = end === -1 ? text.length : end + tag[0].length;
        return 'quoted';
      }
    }
    return 'char';
  }
}

function atLineStart(text: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const c = text[j]!;
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  return true;
}

function skipLine(text: string, i: number): number {
  const end = text.indexOf('\n', i);
  return end === -1 ? text.length : end + 1;
}

/** Skips a block comment; PostgreSQL and SQL Server allow nesting. */
function skipBlockComment(text: string, i: number, nested: boolean): number {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    if (text[j] === '/' && text[j + 1] === '*') {
      if (depth === 0 || nested) depth++;
      j += 2;
    } else if (text[j] === '*' && text[j + 1] === '/') {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else j++;
  }
  return text.length;
}

/**
 * Skips a quoted string or identifier, starting at its opening character. A doubled closing quote
 * is an escaped quote; `backslash` also allows \-escapes.
 */
function skipQuoted(text: string, i: number, close: string, backslash: boolean): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j]!;
    if (c === '\\' && backslash) j += 2;
    else if (c === close && text[j + 1] === close) j += 2;
    else if (c === close) return j + 1;
    else j++;
  }
  return text.length;
}

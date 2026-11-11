/**
 * MySQL-aware helpers shared by the editor (statement under the cursor, confirmations) and the
 * main process (enforcing read-only connections). They understand quotes, comments and the
 * client-side DELIMITER command, but are not a full SQL parser.
 */

export interface SqlStatement {
  /** Statement text without its delimiter, trimmed. */
  sql: string;
  /** Offsets of `sql` in the original text. */
  from: number;
  to: number;
}

/** Splits a script into statements on `;` (or the current DELIMITER), outside quotes and comments. */
export function splitStatements(text: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let delimiter = ';';
  let start = 0; // start of the current statement segment
  let hasContent = false; // the segment holds something other than whitespace and comments
  let i = 0;

  const push = (end: number) => {
    if (hasContent) {
      const raw = text.slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      const sql = raw.trim();
      out.push({ sql, from: start + lead, to: start + lead + sql.length });
    }
    hasContent = false;
  };

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];

    // DELIMITER is a client command; only recognised at the start of a statement.
    if (!hasContent && (ch === 'd' || ch === 'D') && atLineStart(text, i)) {
      const match = /^delimiter[ \t]+(\S+)[^\n]*/i.exec(text.slice(i));
      if (match) {
        delimiter = match[1]!;
        i += match[0].length;
        start = i;
        continue;
      }
    }

    if (ch === '-' && next === '-' && /[\s]/.test(text[i + 2] ?? '\n')) {
      i = skipLine(text, i);
      continue;
    }
    if (ch === '#') {
      i = skipLine(text, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      // MySQL executable comments (/*! ... */) are real SQL.
      if (text[i + 2] === '!') hasContent = true;
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      hasContent = true;
      i = skipQuoted(text, i, ch);
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      push(i);
      i += delimiter.length;
      start = i;
      continue;
    }
    if (!/\s/.test(ch)) hasContent = true;
    i++;
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

export type StatementKind = 'read' | 'write' | 'session';

export interface StatementInfo {
  kind: StatementKind;
  /** First keyword, upper case, e.g. `SELECT`. */
  keyword: string;
  /** An UPDATE or DELETE without WHERE: it touches every row. */
  unbounded: boolean;
}

const READ = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'TABLE', 'VALUES', 'HELP', 'WITH']);
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
]);
const WRITE_IN_WITH = new Set(['UPDATE', 'DELETE', 'INSERT', 'REPLACE']);

export function classify(sql: string): StatementInfo {
  const words = topLevelWords(sql);
  const keyword = words[0] ?? '';
  let kind: StatementKind = READ.has(keyword) ? 'read' : SESSION.has(keyword) ? 'session' : 'write';

  if (keyword === 'WITH' && words.some((w) => WRITE_IN_WITH.has(w))) kind = 'write';
  if (keyword === 'SELECT' || keyword === 'WITH') {
    // SELECT ... INTO OUTFILE / DUMPFILE writes a file on the server.
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] === 'INTO' && (words[i + 1] === 'OUTFILE' || words[i + 1] === 'DUMPFILE')) {
        kind = 'write';
      }
    }
  }
  const effective = keyword === 'WITH' ? (words.find((w) => WRITE_IN_WITH.has(w)) ?? keyword) : keyword;
  const unbounded = (effective === 'UPDATE' || effective === 'DELETE') && !words.includes('WHERE');
  return { kind, keyword, unbounded };
}

/**
 * Why a statement may not run on a read-only connection, or null when it may. Besides writes,
 * this blocks the ways to switch the session back to read-write.
 */
export function readOnlyViolation(sql: string): string | null {
  const info = classify(sql);
  if (info.kind === 'write') return `${info.keyword || 'Dit statement'} wijzigt gegevens.`;
  const words = topLevelWords(sql);
  const touchesAccessMode =
    (info.keyword === 'SET' &&
      (words.includes('TRANSACTION') ||
        /\b(transaction_read_only|tx_read_only)\b/i.test(stripComments(sql)))) ||
    (info.keyword === 'START' && words.includes('WRITE'));
  return touchesAccessMode ? 'De alleen-lezen-modus kan niet worden uitgezet.' : null;
}

/** Keywords and bare identifiers outside quotes, comments and parentheses, upper-cased. */
export function topLevelWords(sql: string): string[] {
  const words: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-' && /\s/.test(sql[i + 2] ?? '\n')) i = skipLine(sql, i);
    else if (ch === '#') i = skipLine(sql, i);
    else if (ch === '/' && next === '*' && sql[i + 2] !== '!') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === '/' && next === '*') i += 3; // executable comment: read its contents
    else if (ch === "'" || ch === '"' || ch === '`') i = skipQuoted(sql, i, ch);
    else if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))!;
      if (depth === 0 || words.length === 0) words.push(match[0].toUpperCase());
      i += match[0].length;
    } else i++;
  }
  return words;
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\/|--\s[^\n]*|#[^\n]*/g, ' ');
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

/** Skips a quoted string or identifier; handles doubled quotes and backslash escapes. */
function skipQuoted(text: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j]!;
    if (c === '\\' && quote !== '`') j += 2;
    else if (c === quote && text[j + 1] === quote) j += 2;
    else if (c === quote) return j + 1;
    else j++;
  }
  return text.length;
}

/** JSON helpers for the grid and the cell editor (no editor code, so the grid stays light). */

/** Where a JSON text is invalid, for the status line; null when it parses. */
export function jsonProblem(text: string): { message: string; line: number; col: number } | null {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // V8: "… in JSON at position 12 (line 2 column 5)" or "… at position 12".
    const lineCol = /line (\d+) column (\d+)/.exec(message);
    if (lineCol)
      return { message: cleanJsonMessage(message), line: +lineCol[1]!, col: +lineCol[2]! };
    const at = /position (\d+)/.exec(message);
    const pos = at ? Number(at[1]) : text.length;
    const before = text.slice(0, pos).split('\n');
    return {
      message: cleanJsonMessage(message),
      line: before.length,
      col: (before.at(-1)?.length ?? 0) + 1,
    };
  }
}

/** The parser's message in Dutch, without the position (the status line gives line and column). */
function cleanJsonMessage(message: string): string {
  const m = message
    .replace(/\s*\(line \d+ column \d+\)/, '')
    .replace(/,? (in JSON )?at position \d+/, '');
  const token = /Unexpected token '(.+?)'/.exec(m);
  if (/Unexpected end of JSON input/.test(m)) return 'de JSON houdt te vroeg op';
  if (/Unexpected non-whitespace character after JSON/.test(m))
    return 'er staat nog iets na het einde van de JSON';
  if (/Expected property name or '\}'/.test(m))
    return 'verwacht een naam tussen "aanhalingstekens" of }';
  if (/Expected ',' or '\}' after property value/.test(m)) return 'verwacht , of } na de waarde';
  if (/Expected ',' or '\]' after array element/.test(m)) return 'verwacht , of ] na het element';
  if (/Expected ':' after property name/.test(m)) return 'verwacht : na de naam';
  if (/Expected double-quoted property name/.test(m))
    return 'namen moeten tussen "dubbele aanhalingstekens" (en geen komma voor })';
  if (/Bad control character in string literal/.test(m))
    return 'een tab of nieuwe regel binnen een tekst moet als \\t of \\n';
  if (/Unterminated string/.test(m)) return 'een tekst wordt niet afgesloten met "';
  if (token) return `onverwacht teken ${token[1]}`;
  return m;
}

/** A value that looks like JSON: an object or array (scalars are left as text). */
export function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return (
    ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) &&
    jsonProblem(t) === null
  );
}

export function formatJson(text: string): string {
  return JSON.stringify(JSON.parse(text), null, 2);
}

export function compactJson(text: string): string {
  return JSON.stringify(JSON.parse(text));
}

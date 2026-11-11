/**
 * Markdown to HTML for our own release notes: headings, paragraphs, lists, tables, quotes, bold,
 * italic, inline code and https links. All text is escaped first, so nothing in the notes can
 * become markup; Angular sanitises [innerHTML] on top of that.
 */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      // Notes start at "##"; in the dialog the version is the h2, so shift one level down.
      const level = Math.min(heading[1]!.length + 1, 5);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*[-*]\s+/, '');
        i++;
        // Continuation lines (indented, not a new item).
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*[-*]\s+/.test(lines[i]!)) {
          item += ' ' + lines[i]!.trim();
          i++;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) body.push(cells(lines[i++]!));
      out.push(
        '<table><thead><tr>' +
          head.map((c) => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>',
      );
      continue;
    }
    // Paragraph: until a blank line or another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,4}\s|\s*[-*]\s+|\s*>|\s*\|)/.test(lines[i]!)
    ) {
      para.push(lines[i]!.trim());
      i++;
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text: string): string {
  // Code spans first, so their contents are not formatted.
  const parts = text.split(/(`[^`]+`)/);
  return parts
    .map((part) => {
      if (/^`[^`]+`$/.test(part)) return `<code>${escape(part.slice(1, -1))}</code>`;
      return escape(part)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(
          /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g,
          (_m, label: string, url: string) =>
            `<a href="${url}" target="_blank" rel="noopener">${label}</a>`,
        );
    })
    .join('');
}

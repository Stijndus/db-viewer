import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders the blocks used in the release notes', () => {
    const html = renderMarkdown(
      [
        '## Nieuw',
        '',
        '**Tabbladen**',
        '',
        '- Een klik op een `tabel` opent',
        '  een tabblad',
        '- Zie [de site](https://example.com)',
        '',
        '> **Let op** dit',
        '',
        '| Bestand | Wanneer |',
        '| --- | --- |',
        '| `a.exe` | Installeren |',
      ].join('\n'),
    );
    expect(html).toContain('<h3>Nieuw</h3>');
    expect(html).toContain('<p><strong>Tabbladen</strong></p>');
    expect(html).toContain('<li>Een klik op een <code>tabel</code> opent een tabblad</li>');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener">de site</a>',
    );
    expect(html).toContain('<blockquote><strong>Let op</strong> dit</blockquote>');
    expect(html).toContain('<th>Bestand</th>');
    expect(html).toContain('<td><code>a.exe</code></td>');
  });

  it('escapes HTML and refuses non-https links', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) `<b>`');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<code>&lt;b&gt;</code>');
  });
});

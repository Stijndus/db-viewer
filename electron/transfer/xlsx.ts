import { crc32, createDeflateRaw } from 'node:zlib';
import type { Writable } from 'node:stream';

/**
 * A minimal streaming .xlsx writer: rows go straight into a deflated zip entry, so an export of
 * millions of rows never sits in memory. Text is written as inline strings, numbers as numbers.
 * Past Excel's 1,048,576 rows a sheet, the next sheet starts.
 */
export const MAX_SHEET_ROWS = 1_048_576;

interface Entry {
  name: string;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/** Zip with deflate and data descriptors (sizes after the data), as streaming requires. */
class ZipWriter {
  private offset = 0;
  private readonly entries: Entry[] = [];

  constructor(private readonly out: Writable) {}

  private write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    return new Promise((resolve, reject) => {
      if (this.out.write(chunk)) resolve();
      else {
        this.out.once('drain', resolve);
        this.out.once('error', reject);
      }
    });
  }

  /** Starts an entry; returns a function to add data and one to finish it. */
  async open(name: string): Promise<{ add(text: string): Promise<void>; close(): Promise<void> }> {
    const nameBytes = Buffer.from(name, 'utf8');
    const offset = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(dosTime(), 10);
    header.writeUInt16LE(nameBytes.length, 26);
    await this.write(Buffer.concat([header, nameBytes]));

    const deflate = createDeflateRaw({ level: 6 });
    let crc = 0;
    let size = 0;
    let compressed = 0;
    const pending: Buffer[] = [];
    deflate.on('data', (d: Buffer) => pending.push(d));
    const flushOut = async () => {
      while (pending.length) {
        const chunk = pending.shift()!;
        compressed += chunk.length;
        await this.write(chunk);
      }
    };
    return {
      add: async (text: string) => {
        const bytes = Buffer.from(text, 'utf8');
        crc = crc32(bytes, crc);
        size += bytes.length;
        if (!deflate.write(bytes)) await new Promise((r) => deflate.once('drain', r));
        await flushOut();
      },
      close: async () => {
        // 'end' (not the end() callback): every compressed byte has been emitted by then.
        await new Promise<void>((resolve) => {
          deflate.once('end', resolve);
          deflate.end();
        });
        await flushOut();
        if (size > 0xffffffff || compressed > 0xffffffff) {
          throw new Error('Excel-bestand wordt groter dan 4 GB; kies CSV.');
        }
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
        await this.write(descriptor);
        this.entries.push({ name, crc: crc >>> 0, compressed, size, offset });
      },
    };
  }

  async file(name: string, text: string): Promise<void> {
    const entry = await this.open(name);
    await entry.add(text);
    await entry.close();
  }

  async finish(): Promise<void> {
    const start = this.offset;
    const central: Buffer[] = [];
    for (const e of this.entries) {
      const nameBytes = Buffer.from(e.name, 'utf8');
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0808, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt32LE(dosTime(), 12);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.compressed, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(nameBytes.length, 28);
      h.writeUInt32LE(e.offset, 42);
      central.push(h, nameBytes);
    }
    const dir = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(start, 16);
    await this.write(Buffer.concat([dir, end]));
  }
}

function dosTime(date = new Date()): number {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return ((day << 16) | time) >>> 0;
}

/** One cell value: a number when it is one and fits Excel's precision, else text. */
export type XlsxValue = string | number | null;

export class XlsxWriter {
  private readonly zip: ZipWriter;
  private sheet: { add(text: string): Promise<void>; close(): Promise<void> } | null = null;
  private sheets: string[] = [];
  private rowInSheet = 0;
  private header: string[] = [];
  private buffer = '';

  constructor(
    out: Writable,
    private readonly baseName: string,
  ) {
    this.zip = new ZipWriter(out);
  }

  async start(header: string[]): Promise<void> {
    this.header = header;
    await this.newSheet();
  }

  private async newSheet(): Promise<void> {
    if (this.sheet) await this.closeSheet();
    const n = this.sheets.length + 1;
    this.sheets.push(n === 1 ? this.baseName : `${this.baseName} (${n})`);
    this.sheet = await this.zip.open(`xl/worksheets/sheet${n}.xml`);
    await this.sheet.add(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        '<sheetData>',
    );
    this.rowInSheet = 0;
    await this.row(this.header, true);
  }

  async row(values: XlsxValue[], bold = false): Promise<void> {
    if (this.rowInSheet >= MAX_SHEET_ROWS) await this.newSheet();
    this.rowInSheet++;
    let xml = `<row r="${this.rowInSheet}">`;
    for (const v of values) {
      if (v === null) xml += '<c/>';
      else if (typeof v === 'number') xml += `<c t="n"><v>${v}</v></c>`;
      else
        xml += `<c t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
    }
    this.buffer += xml + '</row>';
    if (this.buffer.length > 256 * 1024) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer && this.sheet) await this.sheet.add(this.buffer);
    this.buffer = '';
  }

  private async closeSheet(): Promise<void> {
    await this.flush();
    await this.sheet!.add('</sheetData></worksheet>');
    await this.sheet!.close();
    this.sheet = null;
  }

  async finish(): Promise<void> {
    await this.closeSheet();
    const sheets = this.sheets;
    await this.zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        '</Types>',
    );
    await this.zip.file(
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    );
    await this.zip.file(
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets
          .map(
            (name, i) =>
              `<sheet name="${xmlText(sheetName(name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
          )
          .join('') +
        '</sheets></workbook>',
    );
    await this.zip.file(
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    );
    await this.zip.file(
      'xl/styles.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
        '<cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs>' +
        '</styleSheet>',
    );
    await this.zip.finish();
  }
}

/** Sheet names: at most 31 characters, none of : \ / ? * [ ]. */
function sheetName(name: string): string {
  return name.replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Export';
}

/** XML-escaped, without characters XML 1.0 forbids (control characters in binary-ish text). */
function xmlText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

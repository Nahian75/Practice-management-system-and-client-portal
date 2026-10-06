import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A real ZIP file with these entries: enough to make Word, Excel and
 * PowerPoint files (which are ZIP files) for tests. Entries are stored as
 * they are, or compressed (`deflate`) as Office itself writes them.
 */
export function zipOf(entries: Record<string, string | Buffer>, options: { deflate?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = options.deflate ? deflateRawSync(data) : data;
    const method = options.deflate ? 8 : 0;
    const nameBytes = Buffer.from(name, 'utf8');
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, nameBytes);

    offset += local.length + nameBytes.length + packed.length;
  }

  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

/** The smallest Word, Excel or PowerPoint file the inspection accepts, plus any extra entries. */
export function officeFile(mainPart: string, extra: Record<string, string | Buffer> = {}, options: { deflate?: boolean } = {}): Buffer {
  return zipOf({ '[Content_Types].xml': CONTENT_TYPES, [mainPart]: '<xml/>', ...extra }, options);
}

/** A relationships part (`*.rels`) holding these relationships, as Office writes them. */
export function relationships(...items: { type: string; target: string; external?: boolean }[]): string {
  const elements = items.map(
    (item, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${item.type}" ` +
      `Target="${item.target}"${item.external ? ' TargetMode="External"' : ''}/>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${elements.join('')}</Relationships>`;
}

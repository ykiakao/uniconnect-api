const { workerData, parentPort } = require('node:worker_threads');
const { PDFDocument, PDFDict, PDFArray, PDFName, PDFStream } = require('pdf-lib');
const { XMLValidator, XMLParser } = require('fast-xml-parser');
const yauzl = require('yauzl');
const sharp = require('sharp');
const { installPdfDecodeBudget } = require('./academic-pdf-budget.cjs');

function requireValid(value) { if (!value) throw new Error('Invalid academic file'); }
async function pdf(bytes) {
  installPdfDecodeBudget();
  requireValid(bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-'));
  requireValid(/%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1')));
  const document = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
  requireValid(!document.isEncrypted && document.getPageCount() > 0 && document.getPageCount() <= 5000);
  const forbidden = new Set(['JavaScript', 'JS', 'OpenAction', 'AA', 'Launch', 'EmbeddedFiles', 'EmbeddedFile', 'Filespec', 'FileAttachment', 'EF', 'FS', 'AF', 'RichMedia', 'Rendition', 'MediaClip', 'Movie', 'Sound', 'XFA', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'URI', 'AcroForm', 'Encrypt']);
  const seen = new Set();
  function walk(value) {
    if (!value || seen.has(value)) return;
    seen.add(value); requireValid(seen.size <= 100000);
    if (value instanceof PDFName) requireValid(!forbidden.has(value.decodeText()));
    if (value instanceof PDFStream) walk(value.dict);
    if (value instanceof PDFDict) for (const [key, item] of value.entries()) { walk(key); walk(item); }
    if (value instanceof PDFArray) for (const item of value.asArray()) walk(item);
  }
  for (const [, object] of document.context.enumerateIndirectObjects()) walk(object);
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crcUpdate(crc, bytes) { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc; }
const parser = new XMLParser({ ignoreAttributes: false, processEntities: true, htmlEntities: false });
const orderedParser = new XMLParser({ ignoreAttributes: false, processEntities: true, htmlEntities: false, preserveOrder: true, trimValues: false, parseTagValue: false });
function wordFields(text) {
  let field = null;
  const localName = key => key.replace(/^@_/,'').split(':').at(-1);
  const attribute = (attributes, name) => {
    const matches = Object.entries(attributes ?? {}).filter(([key]) => localName(key) === name);
    requireValid(matches.length === 1);
    return matches[0][1];
  };
  const allowed = instruction => requireValid(typeof instruction === 'string' && instruction.length <= 4096 && /^\s*(?:PAGE|NUMPAGES|SECTION|SECTIONPAGES)(?:\s+\\\*\s+(?:MERGEFORMAT|Arabic|ROMAN|ALPHABETIC|Ordinal|CardText|OrdText))*\s*$/i.test(instruction));
  const content = children => (children ?? []).map(node => Object.hasOwn(node,'#text') ? String(node['#text']) : '').join('');
  function walk(nodes) {
    for (const node of nodes ?? []) for (const [key,children] of Object.entries(node)) {
      if (key === ':@' || key === '#text') continue;
      const tag = localName(key), attributes = node[':@'];
      if (tag === 'fldSimple') { requireValid(field === null); allowed(attribute(attributes,'instr')); }
      if (tag === 'fldChar') {
        const type = attribute(attributes,'fldCharType');
        if (type === 'begin') { requireValid(field === null); field = { instruction: '', reading: true }; }
        else if (type === 'separate') { requireValid(field?.reading); allowed(field.instruction); field.reading = false; }
        else if (type === 'end') { requireValid(field !== null); allowed(field.instruction); field = null; }
        else throw new Error('Unsupported Word field');
      }
      if (tag === 'instrText') { requireValid(field?.reading); field.instruction += content(children); requireValid(field.instruction.length <= 4096); }
      if (Array.isArray(children)) walk(children);
    }
  }
  walk(orderedParser.parse(text)); requireValid(field === null);
}
function xml(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  requireValid(!/<!DOCTYPE|<!ENTITY/i.test(text) && XMLValidator.validate(text) === true);
  const entityText = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g,'');
  requireValid(!/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/.test(entityText));
  const value = parser.parse(text);
  wordFields(text);
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      requireValid(!['altChunk', 'OLEObject', 'object', 'control'].includes(key.split(':').at(-1)));
      if (key.replace(/^@_/, '').split(':').at(-1) === 'TargetMode') requireValid(String(item).trim().toLowerCase() !== 'external');
      if (['@_ContentType','@_Type'].includes(key)) requireValid(!/macroenabled|vbaProject|activeX|oleObject|attachedTemplate|aFChunk|externalLink/i.test(String(item)));
      if (key === '@_Target') requireValid(!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(String(item).trim()));
      walk(item);
    }
  }
  walk(value); return value;
}
async function docx(bytes) {
  const entries = new Map(), ranges = [];
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      const directoryStart = zip.readEntryCursor;
      if (!Number.isSafeInteger(directoryStart) || directoryStart < 0 || directoryStart > bytes.length) return reject(new Error('Invalid ZIP directory'));
      let total = 0, count = 0;
      const fail = error => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        try {
          const name = entry.fileName;
          requireValid(++count <= 2000 && !entries.has(name) && !/[\\:\x00]/.test(name) && !name.startsWith('/') && !name.split('/').includes('..'));
          requireValid(!(entry.generalPurposeBitFlag & 1) && [0, 8].includes(entry.compressionMethod));
          requireValid(((entry.externalFileAttributes >>> 16) & 0xf000) !== 0xa000);
          requireValid(!/vba|activex|embeddings|\.(?:exe|dll|js|vbs|hta|html?|svg|bin)$/i.test(name));
          total += entry.uncompressedSize;
          requireValid(total <= 50_000_000 && entry.uncompressedSize <= Math.max(1, entry.compressedSize) * 100);
          const offset = entry.relativeOffsetOfLocalHeader;
          requireValid(offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50);
          const localFlags = bytes.readUInt16LE(offset + 6);
          requireValid(localFlags === entry.generalPurposeBitFlag && bytes.readUInt16LE(offset + 8) === entry.compressionMethod);
          const nameLength = bytes.readUInt16LE(offset + 26);
          requireValid(offset + 30 + nameLength <= bytes.length);
          const localName = bytes.subarray(offset + 30, offset + 30 + nameLength);
          requireValid((localFlags & 0x800) || localName.every(byte => byte < 128));
          requireValid(new TextDecoder('utf-8', { fatal: true }).decode(localName) === name);
          const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
          const end = start + entry.compressedSize;
          requireValid(end <= directoryStart);
          let localEnd = end;
          if (localFlags & 8) {
            const descriptor = bytes.readUInt32LE(end) === 0x08074b50 ? end + 4 : end;
            requireValid(descriptor + 12 <= directoryStart);
            requireValid(bytes.readUInt32LE(descriptor) === (entry.crc32 >>> 0) && bytes.readUInt32LE(descriptor + 4) === entry.compressedSize && bytes.readUInt32LE(descriptor + 8) === entry.uncompressedSize);
            localEnd = descriptor + 12;
          } else {
            requireValid(bytes.readUInt32LE(offset + 14) === (entry.crc32 >>> 0) && bytes.readUInt32LE(offset + 18) === entry.compressedSize && bytes.readUInt32LE(offset + 22) === entry.uncompressedSize);
          }
          requireValid(!ranges.some(([a, b]) => offset < b && localEnd > a));
          ranges.push([offset, localEnd]);
          const keep = /(?:\.xml|\.rels)$/.test(name);
          requireValid(!keep || entry.uncompressedSize <= 2_000_000);
          entries.set(name, null);
          zip.openReadStream(entry, (error, stream) => {
            if (error) return fail(error);
            let size = 0, crc = 0xffffffff; const chunks = [];
            stream.on('error', fail);
            stream.on('data', chunk => {
              size += chunk.length;
              if (size > entry.uncompressedSize || size > 50_000_000) { stream.destroy(); return fail(new Error('Expanded size limit')); }
              crc = crcUpdate(crc, chunk); if (keep) chunks.push(chunk);
            });
            stream.on('end', () => {
              try {
                requireValid(size === entry.uncompressedSize && ((crc ^ 0xffffffff) >>> 0) === (entry.crc32 >>> 0));
                if (keep) entries.set(name, xml(Buffer.concat(chunks)));
                zip.readEntry();
              } catch (error) { fail(error); }
            });
          });
        } catch (error) { fail(error); }
      });
      zip.readEntry();
    });
  });
  const types = entries.get('[Content_Types].xml')?.Types;
  const overrides = [].concat(types?.Override ?? []);
  requireValid(overrides.some(item => item['@_PartName'] === '/word/document.xml' && item['@_ContentType'] === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'));
  requireValid(entries.get('word/document.xml')?.['w:document']?.['@_xmlns:w'] === 'http://schemas.openxmlformats.org/wordprocessingml/2006/main');
  const rels = [].concat(entries.get('_rels/.rels')?.Relationships?.Relationship ?? []);
  requireValid(rels.some(item => item['@_Type'] === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' && item['@_Target'] === 'word/document.xml'));
}
async function image(bytes, expected) {
  sharp.cache(false); sharp.concurrency(1);
  const input = sharp(bytes, { failOn: 'warning', limitInputPixels: 25_000_000 });
  const metadata = await input.metadata();
  requireValid(metadata.format === expected && metadata.width > 0 && metadata.height > 0 && metadata.width <= 16384 && metadata.height <= 16384 && (metadata.pages ?? 1) === 1);
  await input.raw().toBuffer();
}
async function run() {
  const bytes = Buffer.from(workerData.bytes);
  switch (workerData.contentType) {
    case 'application/pdf': return pdf(bytes);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return docx(bytes);
    case 'image/png': return image(bytes, 'png');
    case 'image/jpeg': return image(bytes, 'jpeg');
    default: throw new Error('Unsupported format');
  }
}
run().then(() => parentPort.postMessage('valid'), () => parentPort.postMessage('invalid'));

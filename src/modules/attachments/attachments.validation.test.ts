import { PDFDocument, PDFName } from 'pdf-lib';
import sharp from 'sharp';
import { zipSync, strToU8, unzipSync, Zip, ZipPassThrough } from 'fflate';
import { inspectAcademicFile } from './attachments.validation';

const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function docx(extra: Record<string, Uint8Array> = {}) {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>'),
    ...extra,
  }));
}
describe('academic file content validation', () => {
  it('accepts a structurally valid PDF and calculates the actual hash/size', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    expect(await inspectAcademicFile(bytes, 'application/pdf')).toMatchObject({ contentType: 'application/pdf', extension: 'pdf', sizeBytes: bytes.length, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it.each(['png', 'jpeg'] as const)('fully decodes %s', async format => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).toFormat(format).toBuffer();
    expect(await inspectAcademicFile(bytes, `image/${format}`)).toMatchObject({ contentType: `image/${format}`, extension: format === 'jpeg' ? 'jpg' : 'png' });
    await expect(inspectAcademicFile(bytes.subarray(0, 20), `image/${format}`)).rejects.toMatchObject({ statusCode: 415 });
  });
  it('validates OOXML instead of accepting every ZIP', async () => {
    expect(await inspectAcademicFile(docx(), docxMime)).toMatchObject({ extension: 'docx' });
    await expect(inspectAcademicFile(Buffer.from(zipSync({ 'test.txt': strToU8('not Word') })), docxMime)).rejects.toMatchObject({ statusCode: 415 });
  });
  it('accepts a consistent streaming ZIP with data descriptors',async()=>{
    const bytes=await new Promise<Buffer>((resolve,reject)=>{
      const chunks:Buffer[]=[];
      const zip=new Zip((error,chunk,final)=>{if(error)return reject(error);chunks.push(Buffer.from(chunk));if(final)resolve(Buffer.concat(chunks))});
      for(const [name,part] of Object.entries(unzipSync(docx()))) { const entry=new ZipPassThrough(name);zip.add(entry);entry.push(part,true); }
      zip.end();
    });
    expect(await inspectAcademicFile(bytes,docxMime)).toMatchObject({extension:'docx'});
  });
  it('rejects MIME spoofing, empty content, oversized content and truncated PDF', async () => {
    await expect(inspectAcademicFile(docx(), 'application/pdf')).rejects.toMatchObject({ statusCode: 415 });
    await expect(inspectAcademicFile(Buffer.alloc(0), 'image/png')).rejects.toMatchObject({ statusCode: 415 });
    await expect(inspectAcademicFile(Buffer.alloc(10000001), 'image/png')).rejects.toMatchObject({ statusCode: 413 });
    await expect(inspectAcademicFile(Buffer.from('%PDF-1.7\nnot a PDF\n%%EOF'), 'application/pdf')).rejects.toMatchObject({ statusCode: 415 });
  });
  it('rejects PDF scripts even in compressed object streams', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addJavaScript('unsafe', 'app.alert("x")');
    await expect(inspectAcademicFile(Buffer.from(await pdf.save()), 'application/pdf')).rejects.toMatchObject({ statusCode: 415 });
  });
  it('rejects embedded PDF files even when their optional Type entries are absent',async()=>{
    const pdf=await PDFDocument.create();const page=pdf.addPage();
    const payload=pdf.context.register(pdf.context.stream(Buffer.from('synthetic harmless payload')));
    const specification=pdf.context.obj({F:'payload.exe',EF:{F:payload}});
    const annotation=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'FileAttachment',Rect:[0,0,10,10],FS:specification}));
    page.node.set(PDFName.of('Annots'),pdf.context.obj([annotation]));
    await expect(inspectAcademicFile(Buffer.from(await pdf.save()),'application/pdf')).rejects.toMatchObject({statusCode:415});
  });
  it('bounds PDF object-stream decompression before parser allocation can grow without limit',async()=>{
    const pdf=await PDFDocument.create();pdf.addPage();
    const expanded=Buffer.concat([Buffer.from('999 0 ('),Buffer.alloc(17*1024*1024,65),Buffer.from(')')]);
    pdf.context.register(pdf.context.flateStream(expanded,{Type:'ObjStm',N:1,First:6}));
    const bytes=Buffer.from(await pdf.save({useObjectStreams:false}));expect(bytes.length).toBeLessThan(1000000);
    await expect(inspectAcademicFile(bytes,'application/pdf')).rejects.toMatchObject({statusCode:415});
  });
  it('rejects local/central ZIP filename disagreement before distributing the package',async()=>{
    const bytes=docx({'word/payload.txt':strToU8('synthetic')});
    const position=bytes.indexOf(Buffer.from('word/payload.txt'));
    expect(position).toBeGreaterThan(0);Buffer.from('../x/payload.txt').copy(bytes,position);
    await expect(inspectAcademicFile(bytes,docxMime)).rejects.toMatchObject({statusCode:415});
  });
  it('allows basic page-number fields but rejects unsupported automatic field instructions',async()=>{
    const word=(body:string)=>strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:x="urn:ignored" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x"><w:body><w:p>${body}</w:p></w:body></w:document>`);
    expect(await inspectAcademicFile(docx({'word/document.xml':word('<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>')}),docxMime)).toMatchObject({extension:'docx'});
    expect(await inspectAcademicFile(docx({'word/document.xml':word('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>P</w:instrText></w:r><w:r><w:instrText>AGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>')}),docxMime)).toMatchObject({extension:'docx'});
    for(const body of [
      '<w:fldSimple w:instr="INCLUDETEXT &quot;https://example.invalid/source.docx&quot;"/>',
      '<w:fldSimple x:instr="PAGE" w:instr="INCLUDETEXT &quot;https://example.invalid/source.docx&quot;"/>',
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>INCLUDE</w:instrText></w:r><w:r><w:instrText>TEXT &quot;https://example.invalid/source.docx&quot;</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>',
    ]) await expect(inspectAcademicFile(docx({'word/document.xml':word(body)}),docxMime)).rejects.toMatchObject({statusCode:415});
  });
  it.each<Record<string, Uint8Array>>([
    { 'word/vbaProject.bin': new Uint8Array([1]) },
    { 'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>') },
    { 'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship TargetMode="&#x45;xternal" Target="https://example.invalid/template.dotm"/></Relationships>') },
    { 'word/_rels/document.xml.rels': strToU8('<Relationships><Relationship TargetMode="&#69;xternal" Target="https://example.invalid"/></Relationships>') },
    { 'word/document.xml': strToU8('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]><w:document>&x;</w:document>') },
    { '../escape.xml': strToU8('<x/>') },
    { 'word/document.xml': strToU8('<w:document>') },
    { 'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">&undeclared;</w:document>') },
  ])('rejects unsafe or malformed DOCX', async extra => {
    await expect(inspectAcademicFile(docx(extra), docxMime)).rejects.toMatchObject({ statusCode: 415 });
  });
});

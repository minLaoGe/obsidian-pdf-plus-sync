import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts } from '@cantoo/pdf-lib';

export interface TextBox {
    id?: string;
    source?: string;
    originalText?: string;
    autoFont?: boolean;
    autoColor?: boolean;
    page: number;
    rect: [number, number, number, number];
    text: string;
    fontSize: number;
    color: string;
}
export function validateTextBox(box: TextBox): void {
    if (!Number.isSafeInteger(box.page) || box.page < 1) throw new Error('无效的 PDF 页码');
    if (!box.text.trim() || box.text.length > 5000) throw new Error('文字不能为空，最多 5000 个字符');
    if (!Number.isFinite(box.fontSize) || box.fontSize < 6 || box.fontSize > 72) throw new Error('字号须在 6–72 之间');
    if (!/^#[\da-f]{6}$/i.test(box.color)) throw new Error('无效的文字颜色');
    const [x0, y0, x1, y1] = box.rect;
    if (!box.rect.every(Number.isFinite) || x1 <= x0 || y1 <= y0 || x1 - x0 > 2000 || y1 - y0 > 3000) throw new Error('无效的文字框大小');
}
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
    const result: string[] = [];
    for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
        let line = '';
        for (const char of Array.from(paragraph)) {
            if (line && measure(line + char) > maxWidth) { result.push(line); line = char; }
            else line += char;
        }
        result.push(line);
    }
    return result;
}
export function annotationRef(page: import('@cantoo/pdf-lib').PDFPage, id: string): PDFRef | undefined {
    return page.node.Annots()?.asArray().find((ref): ref is PDFRef => ref instanceof PDFRef
        && (ref.generationNumber === 0 ? `${ref.objectNumber}R` : `${ref.objectNumber}R${ref.generationNumber}`) === id);
}

/** Standard FreeText annotation. Unicode Contents remains editable; PNG AP preserves CJK glyphs offline. */
export async function writeTextBox(document: PDFDocument, box: TextBox, png: Uint8Array, author: string): Promise<string> {
    validateTextBox(box);
    if (box.page > document.getPageCount()) throw new Error('PDF 页码超出范围');
    const page = document.getPage(box.page - 1);
    const [x0,y0,x1,y1] = box.rect;
    const bounds = page.getCropBox();
    if (x0 < bounds.x - 1 || y0 < bounds.y - 1 || x1 > bounds.x + bounds.width + 1 || y1 > bounds.y + bounds.height + 1) {
        throw new Error('文字框超出页面，请移动到页面内');
    }
    let ref = box.id ? annotationRef(page, box.id) : undefined;
    if (box.id && !ref) throw new Error('该文字批注已被修改或删除，请重新打开 PDF');
    let annotation: PDFDict;
    if (ref) {
        annotation = document.context.lookup(ref, PDFDict);
        if (annotation.get(PDFName.of('Subtype'))?.toString() !== '/FreeText') throw new Error('只能编辑文字框批注');
    } else annotation = document.context.obj({ Type: 'Annot', Subtype: 'FreeText' });
    const image = await document.embedPng(png);
    const font = await document.embedFont(StandardFonts.Helvetica);
    const width = x1-x0, height = y1-y0;
    const appearance = document.context.flateStream(`q\n${width} 0 0 ${height} 0 0 cm\n/NoteImage Do\nQ`, {
        Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0,0,width,height],
        Resources: { XObject: { NoteImage: image.ref } }
    });
    const rgb = [1,3,5].map(i => parseInt(box.color.slice(i,i+2),16)/255);
    const values = document.context.obj({
        Rect: box.rect, Contents: PDFHexString.fromText(box.text),
        T: PDFHexString.fromText(author || 'PDF++ Sync'), M: PDFString.fromDate(new Date()),
        DA: PDFString.of(`/Helv ${box.fontSize} Tf ${rgb.join(' ')} rg`),
        DR: { Font: { Helv: font.ref } }, Q: 0, F: 4, C: rgb,
        Border: [0,0,0], AP: { N: document.context.register(appearance) },
        PDFPlusSyncFontSize: box.fontSize, PDFPlusSyncColor: PDFString.of(box.color),
        PDFPlusSyncVersion: 1
    });
    for (const [key,value] of values.entries()) annotation.set(key,value);
    if (!ref) {
        annotation.set(PDFName.of('NM'), PDFString.of(`pdf-plus-sync:${crypto.randomUUID()}`));
        ref = document.context.register(annotation);
        page.node.addAnnot(ref);
    }
    return ref.generationNumber === 0 ? `${ref.objectNumber}R` : `${ref.objectNumber}R${ref.generationNumber}`;
}
export function readTextBox(document: PDFDocument, pageNumber: number, id: string): TextBox {
    const page = document.getPage(pageNumber-1);
    const ref = annotationRef(page,id);
    if (!ref) throw new Error('文字批注不存在');
    const annotation = document.context.lookup(ref, PDFDict);
    if (annotation.get(PDFName.of('Subtype'))?.toString() !== '/FreeText') throw new Error('不是文字批注');
    const contents = annotation.lookup(PDFName.of('Contents'));
    const rect = annotation.lookup(PDFName.of('Rect'), PDFArray).asArray().map(n => (n as PDFNumber).asNumber()) as TextBox['rect'];
    const size = annotation.get(PDFName.of('PDFPlusSyncFontSize'));
    const color = annotation.get(PDFName.of('PDFPlusSyncColor'));
    const box: TextBox = { id,page:pageNumber,rect,text: contents instanceof PDFHexString || contents instanceof PDFString ? contents.decodeText() : '',
        fontSize: size instanceof PDFNumber ? size.asNumber() : 12,
        color: color instanceof PDFString ? color.decodeText() : '#222222' };
    box.source = textBoxFingerprint(box);
    return box;
}
export function deleteTextBox(document: PDFDocument, pageNumber: number, id: string): void {
    const page = document.getPage(pageNumber-1);
    const ref = annotationRef(page,id);
    if (!ref) throw new Error('文字批注不存在或已删除');
    const annotation = document.context.lookup(ref, PDFDict);
    if (annotation.get(PDFName.of('Subtype'))?.toString() !== '/FreeText') throw new Error('只能删除文字框批注');
    page.node.removeAnnot(ref);
}

export function textBoxFingerprint(box: TextBox): string {
    return JSON.stringify([box.text, box.rect, box.fontSize, box.color]);
}

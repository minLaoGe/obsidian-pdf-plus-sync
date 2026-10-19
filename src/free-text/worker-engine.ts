import { PDFDocument, PDFHexString, PDFString } from '@cantoo/pdf-lib';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { annotationRef, deleteTextBox, readTextBox, textBoxFingerprint, validateTextBox, writeTextBox } from './pdf';
import type { TextBox } from './pdf';
import { renderOffscreen } from './render';

export interface TextOperation { kind?: 'highlight'; rects?: TextBox['rect'][]; opacity?: number; key: string; box: TextBox; deleted?: boolean; version: number; }
export interface BatchInput { bytes: ArrayBuffer; operations: TextOperation[]; author: string; }
export interface BatchOutput { bytes: Uint8Array; inputDigest: string; notes: Record<string, TextBox>; }
export function digest(bytes: ArrayBuffer | Uint8Array): string { return bytesToHex(sha256(new Uint8Array(bytes))); }
export async function indexNotes(bytes: ArrayBuffer): Promise<TextBox[]> {
    const doc = await PDFDocument.load(bytes);
    const notes: TextBox[] = [];
    doc.getPages().forEach((page, index) => {
        for (const ref of page.node.Annots()?.asArray() ?? []) {
            const id = ref.toString().replace(/(\d+) (\d+) R/, (_, n, g) => Number(g) ? `${n}R${g}` : `${n}R`);
            try { notes.push(readTextBox(doc, index + 1, id)); } catch { /* Not a FreeText annotation. */ }
        }
    });
    return notes;
}
export async function processBatch(input: BatchInput, renderer = renderOffscreen): Promise<BatchOutput> {
    const inputDigest = digest(input.bytes);
    const doc = await PDFDocument.load(input.bytes);
    const notes: Record<string, TextBox> = {};
    for (const operation of input.operations) {
        const box = { ...operation.box, rect: [...operation.box.rect] as TextBox['rect'] };
        if (operation.kind === 'highlight') {
            const rects = operation.rects ?? [];
            if (!Number.isSafeInteger(box.page) || box.page < 1 || box.page > doc.getPageCount() || !/^#[\da-f]{6}$/i.test(box.color) || !rects.length || rects.length > 10000) throw new Error('无效高亮草稿');
            const page = doc.getPage(box.page-1), bounds = page.getCropBox();
            for (const rect of rects) if (rect.length !== 4 || !rect.every(Number.isFinite) || rect[2] <= rect[0] || rect[3] <= rect[1] || rect[0] < bounds.x-1 || rect[1] < bounds.y-1 || rect[2] > bounds.x+bounds.width+1 || rect[3] > bounds.y+bounds.height+1) throw new Error('高亮区域超出页面');
            const merged = [Math.min(...rects.map(r=>r[0])),Math.min(...rects.map(r=>r[1])),Math.max(...rects.map(r=>r[2])),Math.max(...rects.map(r=>r[3]))];
            const annotation = doc.context.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: merged,
                QuadPoints: rects.flatMap(([x0,y0,x1,y1]) => [x0,y1,x1,y1,x0,y0,x1,y0]),
                C: [1,3,5].map(i=>parseInt(box.color.slice(i,i+2),16)/255),
                CA: Math.max(0.05,Math.min(1,operation.opacity ?? 0.35)), Border: [0,0,0], F: 4,
                T: PDFHexString.fromText(input.author || 'PDF++ Sync'), M: PDFString.fromDate(new Date()),
                NM: PDFHexString.fromText(operation.key) });
            page.node.addAnnot(doc.context.register(annotation));
            continue;
        }
        if (box.id) {
            const current = readTextBox(doc, box.page, box.id);
            if (box.source && textBoxFingerprint(current) !== box.source) throw new Error('文字已被其他操作修改，请重新打开后再编辑');
            if (!box.source && box.originalText !== undefined && current.text !== box.originalText) throw new Error('文字已被其他操作修改，请重新打开后再编辑');
            if (box.autoFont) box.fontSize = current.fontSize;
            if (box.autoColor) box.color = current.color;
        }
        if (operation.deleted || !box.text.trim()) {
            if (box.id) deleteTextBox(doc, box.page, box.id);
            continue;
        }
        validateTextBox(box);
        const rendered = await renderer(box);
        box.rect[1] = box.rect[3] - rendered.height;
        const id = await writeTextBox(doc, box, rendered.png, input.author);
        notes[operation.key] = readTextBox(doc, box.page, id);
    }
    return { bytes: await doc.save(), inputDigest, notes };
}

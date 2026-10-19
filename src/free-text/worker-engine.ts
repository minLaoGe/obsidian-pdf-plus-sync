import { PDFDocument } from '@cantoo/pdf-lib';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { annotationRef, deleteTextBox, readTextBox, textBoxFingerprint, validateTextBox, writeTextBox } from './pdf';
import type { TextBox } from './pdf';
import { renderOffscreen } from './render';

export interface TextOperation { key: string; box: TextBox; deleted?: boolean; version: number; }
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

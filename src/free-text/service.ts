import { Notice, TFile } from 'obsidian';
import { PDFDocument } from '@cantoo/pdf-lib';
import type PDFPlus from 'main';
import { DATA_ROOT, ensureFolder, hashPath } from '../sync/store';
import { deleteTextBox, readTextBox, TextBox, validateTextBox, wrapText, writeTextBox, textBoxFingerprint } from './pdf';

export function renderText(box: TextBox, doc: Document): { png: Uint8Array; height: number } {
    const width = box.rect[2]-box.rect[0];
    const canvas = doc.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前设备不支持文字绘制');
    const font = `${box.fontSize}px -apple-system, BlinkMacSystemFont, "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.font = font;
    const lines = wrapText(box.text, width-8, s => ctx.measureText(s).width);
    const height = Math.max(box.fontSize*1.4+8, lines.length*box.fontSize*1.4+8);
    // Cap the raster size for memory-constrained mobile WebViews.
    const scale = Math.min(3, 4096/width, 4096/height);
    canvas.width = Math.ceil(width*scale);
    canvas.height = Math.ceil(height*scale);
    ctx.scale(scale,scale);
    ctx.font = font;
    ctx.fillStyle = box.color;
    ctx.textBaseline = 'top';
    lines.forEach((line,i) => ctx.fillText(line,4,4+i*box.fontSize*1.4));
    const raw = atob(canvas.toDataURL('image/png').split(',')[1]);
    return { png: Uint8Array.from(raw,c => c.charCodeAt(0)), height };
}

/** Serializes this tool's edits and refuses to overwrite a PDF changed by sync during an edit. */
export class FreeTextService {
    private queue = Promise.resolve();
    constructor(private plugin: PDFPlus) {}
    async read(file: TFile, page: number, id: string): Promise<TextBox> {
        const document = await PDFDocument.load(await this.plugin.app.vault.readBinary(file));
        return readTextBox(document,page,id);
    }
    async save(file: TFile, box: TextBox, ownerDocument: Document): Promise<void> {
        validateTextBox(box);
        const rendered = renderText(box,ownerDocument);
        const finalBox = { ...box, rect: [box.rect[0],box.rect[3]-rendered.height,box.rect[2],box.rect[3]] as TextBox['rect'] };
        await this.edit(file, async doc => {
            if (box.id && box.source && textBoxFingerprint(readTextBox(doc,box.page,box.id)) !== box.source) {
                throw new Error('这段文字已被其他操作修改，请重新打开后再编辑');
            }
            await writeTextBox(doc,finalBox,rendered.png,this.plugin.settings.author);
        });
    }
    async remove(file: TFile, page: number, id: string): Promise<void> {
        await this.edit(file, async doc => { deleteTextBox(doc,page,id); });
    }
    private edit(file: TFile, action: (doc: PDFDocument) => Promise<void>): Promise<void> {
        const task = this.queue.catch(() => {}).then(async () => {
            if (!this.plugin.settings.enablePDFEdit) throw new Error('请先开启 PDF 编辑');
            const vault = this.plugin.app.vault;
            const before = await vault.readBinary(file);
            const document = await PDFDocument.load(before);
            await action(document);
            const output = await document.save();
            const current = await vault.readBinary(file);
            if (!sameBytes(before,current)) throw new Error('PDF 已被其他操作或同步修改，请重新打开后再编辑');
            const folder = `${DATA_ROOT}/backups/${hashPath(file.path)}`;
            const backup = `${folder}/before-text-edit.pdf`;
            if (!(await vault.adapter.exists(backup))) {
                await ensureFolder(vault,folder);
                await vault.createBinary(backup,before);
            }
            // Recheck after backup I/O, before replacing the source.
            if (!sameBytes(before,await vault.readBinary(file))) throw new Error('PDF 在保存前发生变化，请重新打开后重试');
            await vault.modifyBinary(file,output);
            new Notice('文字批注已写入 PDF。请等待 PDF 文件同步完成。');
        });
        this.queue = task;
        return task;
    }
}
function sameBytes(a: ArrayBuffer,b: ArrayBuffer): boolean {
    if (a.byteLength !== b.byteLength) return false;
    const x=new Uint8Array(a), y=new Uint8Array(b);
    return x.every((v,i)=>v===y[i]);
}

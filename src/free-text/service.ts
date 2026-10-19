import { Notice, TFile } from 'obsidian';
import type PDFPlus from 'main';
import { DATA_ROOT, ensureFolder, hashPath } from '../sync/store';
import { textBoxFingerprint } from './pdf';
import type { TextBox } from './pdf';
import type { TextOperation } from './worker-engine';
import { PdfTextWorker } from './worker-client';
import type { PdfTextRunner } from './worker-client';
export { renderText } from './render';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const LOCAL_KEY = 'pdf-plus-sync-text-drafts-v2';

/** Metadata comes from the already-loaded PDF.js page, never a synchronous PDF parse on click. */
export function boxFromAnnotation(annotation: any, page: number): TextBox {
    const text = String(annotation.contentsObj?.str ?? annotation.contents ?? '');
    const color = annotation.color ?? annotation.defaultAppearanceData?.fontColor ?? [34, 34, 34];
    const hex = '#' + Array.from(color as ArrayLike<number>).slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    const rect = [...annotation.rect] as TextBox['rect'];
    // Older image appearances do not expose their font through PDF.js. Refine in a background index.
    const estimated = Math.max(6, Math.min(72, (rect[3] - rect[1] - 8) / (Math.max(1, text.split('\n').length) * 1.4)));
    return { id: annotation.id, page, rect, text, originalText: text, fontSize: Math.round(estimated),
        color: /^#[\da-f]{6}$/i.test(hex) ? hex : '#222222', autoFont: true, autoColor: true };
}

export class FreeTextService {
    highlightColor = '#ffdf00';
    private queue: Promise<unknown> = Promise.resolve();
    private runner: PdfTextRunner;
    private pending = new Map<string, Map<string, TextOperation>>();
    private indexes = new Map<string, { stamp: string; notes: Map<string, TextBox>; ready: Promise<void> }>();
    private saving = new Set<string>();
    private errors = new Map<string, string>();
    private listeners = new Set<(path: string) => void>();
    private committers = new Map<string, Set<() => boolean>>();
    private initialized = false;
    private sequence = 0;
    private persistTimer: number | undefined;
    constructor(private plugin: PDFPlus, runner?: PdfTextRunner) { this.runner = runner ?? new PdfTextWorker(); }
    initialize() {
        if (this.initialized) return;
        this.initialized = true;
        const color = this.plugin.app.loadLocalStorage?.('pdf-plus-highlight-color');
        if (typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)) this.highlightColor = color;
        try {
            const saved = this.plugin.app.loadLocalStorage?.(LOCAL_KEY);
            if (saved?.schema === 1 && Array.isArray(saved.files)) for (const [path, operations] of saved.files) {
                if (typeof path !== 'string' || !Array.isArray(operations)) continue;
                const map = new Map<string, TextOperation>();
                for (const operation of operations) {
                    const b = operation?.box;
                    if (!b || typeof operation.key !== 'string' || typeof b.text !== 'string' || b.text.length > 5000
                        || !Array.isArray(b.rect) || b.rect.length !== 4 || !b.rect.every(Number.isFinite)
                        || !Number.isSafeInteger(b.page) || b.page < 1 || !Number.isFinite(operation.version)) continue;
                    map.set(operation.key, operation); this.sequence = Math.max(this.sequence, operation.version);
                }
                if (map.size) this.pending.set(path, map);
            }
        } catch { /* Preserve availability if client-local storage is unavailable. */ }
    }
    private persistNow() {
        window.clearTimeout(this.persistTimer);
        try { this.plugin.app.saveLocalStorage?.(LOCAL_KEY, { schema: 1, files: [...this.pending].map(([p, m]) => [p, [...m.values()]]) }); }
        catch (error) { console.error('PDF text draft checkpoint failed:', error); }
    }
    private changed(path: string) {
        window.clearTimeout(this.persistTimer);
        this.persistTimer = window.setTimeout(() => this.persistNow(), 150);
        for (const listener of this.listeners) listener(path);
    }
    subscribe(listener: (path: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    addCommitter(path: string, commit: () => boolean): () => void {
        let set = this.committers.get(path); if (!set) this.committers.set(path, set = new Set());
        set.add(commit); return () => { set!.delete(commit); if (!set!.size) this.committers.delete(path); };
    }
    changes(file: TFile | string): TextOperation[] {
        this.initialize(); return [...(this.pending.get(typeof file === 'string' ? file : file.path)?.values() ?? [])].map(clone);
    }
    state(file: TFile | string) {
        const path = typeof file === 'string' ? file : file.path;
        return { count: this.changes(path).length, saving: this.saving.has(path), error: this.errors.get(path) };
    }
    stage(file: TFile, key: string, box: TextBox, deleted = false) {
        this.initialize();
        let map = this.pending.get(file.path); if (!map) this.pending.set(file.path, map = new Map());
        const previous = map.get(key);
        if (previous && previous.deleted === deleted && JSON.stringify(previous.box) === JSON.stringify(box)) return;
        if (!box.id && (deleted || !box.text.trim())) map.delete(key);
        else map.set(key, { key, box: clone(box), deleted, version: ++this.sequence });
        if (!map.size) this.pending.delete(file.path);
        this.errors.delete(file.path); this.changed(file.path);
    }
    setHighlightColor(color: string) {
        if (!/^#[\da-f]{6}$/i.test(color)) return;
        this.highlightColor = color; this.plugin.app.saveLocalStorage?.('pdf-plus-highlight-color', color);
    }
    stageHighlight(file: TFile, page: number, rects: TextBox['rect'][]) {
        this.initialize();
        if (this.saving.has(file.path)) throw new Error('正在保存，请稍后继续标注');
        if (!rects.length) return;
        let map = this.pending.get(file.path); if (!map) this.pending.set(file.path, map = new Map());
        const key = `highlight:${crypto.randomUUID()}`;
        map.set(key, { key, kind: 'highlight', rects: clone(rects), opacity: this.plugin.settings.writeHighlightToFileOpacity,
            box: { page, rect: [...rects[0]], text: '[高亮]', fontSize: 12, color: this.highlightColor }, version: ++this.sequence });
        this.errors.delete(file.path); this.changed(file.path);
    }
    undoHighlight(file: TFile) {
        if (this.saving.has(file.path)) return;
        const map = this.pending.get(file.path); if (!map) return;
        const last = [...map.values()].filter(op=>op.kind === 'highlight').sort((a,b)=>b.version-a.version)[0];
        if (last) { map.delete(last.key); if (!map.size) this.pending.delete(file.path); this.changed(file.path); }
    }
    restore(file: TFile, key: string, operation?: TextOperation) {
        let map = this.pending.get(file.path); if (!map) this.pending.set(file.path, map = new Map());
        if (operation) map.set(key, { ...clone(operation), version: ++this.sequence }); else map.delete(key);
        if (!map.size) this.pending.delete(file.path); this.changed(file.path);
    }
    cached(file: TFile, id: string): TextBox | undefined {
        const box = this.indexes.get(file.path)?.notes.get(id); return box ? clone(box) : undefined;
    }
    preload(file: TFile): Promise<void> {
        const stamp = `${file.stat?.mtime ?? 0}:${file.stat?.size ?? 0}`;
        const existing = this.indexes.get(file.path); if (existing?.stamp === stamp) return existing.ready;
        const index = { stamp, notes: new Map<string, TextBox>(), ready: Promise.resolve() };
        index.ready = (async () => {
            const notes = await this.runner.index(await this.plugin.app.vault.readBinary(file));
            if (this.indexes.get(file.path) !== index) return;
            notes.forEach(note => { if (note.id) index.notes.set(note.id, note); });
        })().catch(error => { if (this.indexes.get(file.path) === index) this.indexes.delete(file.path); throw error; });
        this.indexes.set(file.path, index); return index.ready;
    }
    async read(file: TFile, page: number, id: string): Promise<TextBox> {
        await this.preload(file); const box = this.cached(file, id);
        if (!box || box.page !== page) throw new Error('文字批注不存在'); return box;
    }
    async save(file: TFile, box: TextBox, _ownerDocument: Document): Promise<void> {
        this.stage(file, box.id ?? `new:${crypto.randomUUID()}`, box); await this.savePending(file);
    }
    async remove(file: TFile, page: number, id: string): Promise<void> {
        const box = await this.read(file, page, id); this.stage(file, id, box, true); await this.savePending(file);
    }
    async savePending(file: TFile): Promise<void> {
        for (const commit of this.committers.get(file.path) ?? []) if (!commit()) throw new Error('请先完成当前中文输入，再保存');
        if (this.saving.has(file.path)) return;
        const snapshot = this.changes(file); if (!snapshot.length) return;
        if (!this.plugin.settings.enablePDFEdit) throw new Error('请先开启 PDF 编辑');
        this.saving.add(file.path); this.errors.delete(file.path); this.changed(file.path); this.persistNow();
        const task = this.queue.catch(() => {}).then(async () => {
            const vault = this.plugin.app.vault;
            const before = await vault.readBinary(file);
            const folder = `${DATA_ROOT}/backups/${hashPath(file.path)}`, backup = `${folder}/before-text-edit.pdf`;
            if (!(await vault.adapter.exists(backup))) { await ensureFolder(vault, folder); await vault.createBinary(backup, before); }
            // Parsing, font rasterization, hashing and serialization all run off the UI thread.
            const output = await this.runner.process({ bytes: before, operations: snapshot, author: this.plugin.settings.author });
            if (!(await this.runner.verify(await vault.readBinary(file), output.inputDigest))) {
                throw new Error('PDF 已被其他操作或同步修改；未覆盖文件，本机草稿已保留');
            }
            await vault.modifyBinary(file, output.bytes);
            const current = this.pending.get(file.path);
            for (const operation of snapshot) {
                const newer = current?.get(operation.key); if (!newer) continue;
                if (newer.version === operation.version) current!.delete(operation.key);
                else {
                    const saved = output.notes[operation.key];
                    newer.box.id = saved?.id;
                    newer.box.source = saved?.source;
                    newer.box.originalText = saved?.text;
                }
            }
            if (!current?.size) this.pending.delete(file.path);
            this.indexes.delete(file.path); this.persistNow();
            new Notice('PDF 文字与高亮更改已保存，请等待文件同步完成。');
        });
        this.queue = task;
        try { await task; }
        catch (error) { this.errors.set(file.path, String(error.message ?? error)); throw error; }
        finally { this.saving.delete(file.path); this.changed(file.path); }
    }
    destroy() { this.persistNow(); this.runner.destroy?.(); this.listeners.clear(); }
}

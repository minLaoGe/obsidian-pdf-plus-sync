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
interface EditHistory { key: string; before?: TextOperation; after?: TextOperation; time: number; externalUndo?: () => Promise<void>; externalRedo?: () => Promise<void>; }
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
    private history = new Map<string, EditHistory[]>();
    private future = new Map<string, EditHistory[]>();
    private aliases = new Map<string, Map<string, string>>();
    private originals = new Map<string, Map<string, TextBox | null>>();
    private committed = new Map<string, Map<string, TextBox | null>>();
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
                    if (b.id) { let aliases = this.aliases.get(path); if (!aliases) this.aliases.set(path, aliases = new Map()); aliases.set(b.id, operation.key); }
                    map.set(operation.key, operation); this.sequence = Math.max(this.sequence, operation.version);
                }
                if (map.size) { this.pending.set(path, map); this.history.set(path, [...map.values()].map(op=>({ key: op.key, after: clone(op), time: 0 }))); }
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
        this.initialize(); key = this.keyFor(file, key);
        let map = this.pending.get(file.path); if (!map) this.pending.set(file.path, map = new Map());
        const previous = map.get(key);
        if (previous && previous.deleted === deleted && JSON.stringify(previous.box) === JSON.stringify(box)) return;
        this.record(file.path, key, previous, !box.id && (deleted || !box.text.trim()) ? undefined : { key, box: clone(box), deleted, version: this.sequence + 1 });
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
        if (!rects.length) return;
        let map = this.pending.get(file.path); if (!map) this.pending.set(file.path, map = new Map());
        const key = `highlight:${crypto.randomUUID()}`;
        const operation: TextOperation = { key, kind: 'highlight', rects: clone(rects), opacity: this.plugin.settings.writeHighlightToFileOpacity,
            box: { page, rect: [...rects[0]], text: '[高亮]', fontSize: 12, color: this.highlightColor }, version: ++this.sequence };
        map.set(key, operation); this.record(file.path, key, undefined, operation);
        this.errors.delete(file.path); this.changed(file.path);
    }
    keyFor(file: TFile, key: string) { return this.aliases.get(file.path)?.get(key) ?? key; }
    private record(path: string, key: string, before?: TextOperation, after?: TextOperation) {
        let stack = this.history.get(path); if (!stack) this.history.set(path, stack = []);
        const last = stack[stack.length-1], now = Date.now();
        const typing = before && after && before.box.text !== after.box.text && before.box.color === after.box.color && before.box.fontSize === after.box.fontSize;
        if (typing && last?.key === key && now-last.time < 600 && last.after && last.after.box.text === before.box.text) { last.after = clone(after); last.time = now; }
        else stack.push({ key, before: before ? clone(before) : undefined, after: after ? clone(after) : undefined, time: now });
        this.future.delete(path);
    }
    recordExternal(file: TFile, undo: () => Promise<void>, redo: () => Promise<void>) {
        let stack = this.history.get(file.path); if (!stack) this.history.set(file.path, stack = []);
        stack.push({ key: `external:${crypto.randomUUID()}`, time: Date.now(), externalUndo: undo, externalRedo: redo }); this.future.delete(file.path);
    }
    async undo(file: TFile, redo = false) {
        // A save in flight must finish before inverse operations can refer to its new PDF object IDs.
        if (this.saving.has(file.path)) { await this.queue.catch(()=>{}); }
        const from = (redo ? this.future : this.history).get(file.path);
        const entry = from?.pop(); if (!entry) return;
        try {
            if (entry.externalUndo) await (redo ? entry.externalRedo! : entry.externalUndo)();
            else this.applyHistory(file, entry, redo ? entry.after : entry.before);
            const destination = redo ? this.history : this.future;
            let stack = destination.get(file.path); if (!stack) destination.set(file.path, stack = []); stack.push(entry);
            this.errors.delete(file.path); this.changed(file.path);
        } catch (error) { from!.push(entry); throw error; }
    }
    private applyHistory(file: TFile, entry: EditHistory, target?: TextOperation) {
        const saved = this.committed.get(file.path), hasSaved = saved?.has(entry.key), current = saved?.get(entry.key);
        let operation = target ? clone(target) : undefined;
        if (hasSaved) {
            if (!operation) {
                const original = this.originals.get(file.path)?.get(entry.key);
                if (original) operation = { key: entry.key, box: clone(original), version: 0 };
                else if (current) operation = { ...(entry.after ?? entry.before)!, key: entry.key, box: clone(current), deleted: true, version: 0 };
            }
            if (operation) {
                operation.box.id = current?.id; operation.box.source = current?.source; operation.box.originalText = current?.text;
                if (operation.deleted && !current) operation = undefined;
            }
        }
        let map = this.pending.get(file.path); if (!map) this.pending.set(file.path, map = new Map());
        if (operation) map.set(entry.key, { ...operation, version: ++this.sequence }); else map.delete(entry.key);
        if (!map.size) this.pending.delete(file.path);
    }
    undoHighlight(file: TFile) { void this.undo(file).catch(error => new Notice(`撤销失败：${error.message ?? error}`)); }
    restore(file: TFile, key: string, operation?: TextOperation) {
        key = this.keyFor(file, key);
        this.record(file.path, key, this.pending.get(file.path)?.get(key), operation);
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
            let saved = this.committed.get(file.path); if (!saved) this.committed.set(file.path, saved = new Map());
            let originals = this.originals.get(file.path); if (!originals) this.originals.set(file.path, originals = new Map());
            let aliases = this.aliases.get(file.path); if (!aliases) this.aliases.set(file.path, aliases = new Map());
            const current = this.pending.get(file.path);
            for (const operation of snapshot) {
                if (!originals.has(operation.key)) originals.set(operation.key, output.originals?.[operation.key] ?? null);
                saved.set(operation.key, output.notes[operation.key] ?? null);
                const note = output.notes[operation.key]; if (note?.id) aliases.set(note.id, operation.key);
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

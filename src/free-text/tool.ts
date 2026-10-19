import { Component, Notice, setIcon, setTooltip } from 'obsidian';
import interact from 'interactjs';
import type PDFPlus from 'main';
import type { PDFPageView, PDFViewerChild } from 'typings';
import type { TextBox } from './pdf';
import type { TextOperation } from './worker-engine';
import { boxFromAnnotation } from './service';

interface ActiveEditor {
    key: string; box: TextBox; page: PDFPageView; viewport: PDFPageView['viewport'];
    file: NonNullable<PDFViewerChild['file']>; element: HTMLElement; content: HTMLElement; toolbar: HTMLElement;
    dirty: boolean; composing: boolean; previous?: TextOperation; removeCommitter: () => void;
    interactions: { unset(): unknown }[];
}

/** Browser-style inline text UI. PDF.js supplies cached metadata; Interact.js handles gestures. */
export class FreeTextTool extends Component {
    private placing = false;
    private button: HTMLElement;
    private saveButton: HTMLButtonElement;
    private label: HTMLElement;
    private active: ActiveEditor | null = null;
    private alive = true;
    private pages = new Map<number, PDFPageView>();
    private metadata = new WeakMap<object, Promise<TextBox[]>>();
    private cleanRegions = new WeakMap<object, Map<string, Promise<HTMLCanvasElement>>>();
    private inputTimer: number | undefined;
    private layoutFrame: number | undefined;
    constructor(private plugin: PDFPlus, private child: PDFViewerChild, private toolbar: HTMLElement) { super(); }
    onload() {
        const group = this.toolbar.createDiv({ cls: 'pdf-sync-text-tools' });
        this.button = group.createEl('button', { cls: 'clickable-icon pdf-plus-free-text-button', attr: { 'aria-label': '添加文字', type: 'button' } });
        setIcon(this.button, 'type'); setTooltip(this.button, '添加文字 · 双击页面输入');
        this.saveButton = group.createEl('button', { cls: 'pdf-sync-save', attr: { type: 'button', 'aria-label': '保存 PDF 文字更改' } });
        setIcon(this.saveButton.createSpan(), 'save');
        this.label = this.saveButton.createSpan();
        this.registerDomEvent(this.button, 'click', () => {
            if (!this.editable() || !this.commitCurrent()) return;
            this.setPlacing(!this.placing);
        });
        const highlight = group.createEl('button', { cls: 'clickable-icon', attr: { type: 'button', 'aria-label': '高亮选中的 PDF 文本', title: '选中 PDF 正文后点击高亮' } });
        setIcon(highlight, 'highlighter');
        this.registerDomEvent(highlight, 'pointerdown', event => event.preventDefault());
        this.registerDomEvent(highlight, 'click', () => { void this.highlightSelection(); });
        this.registerDomEvent(this.saveButton, 'click', () => { void this.saveAll(); });
        this.registerDomEvent(this.child.containerEl, 'click', event => {
            if ((event.target as Element)?.closest?.('.pdf-sync-note-hit, .pdf-sync-note-preview')) {
                event.preventDefault(); event.stopImmediatePropagation();
            }
        }, true);
        this.registerDomEvent(this.child.containerEl, 'dblclick', event => this.click(event), true);
        this.registerDomEvent(this.child.containerEl.win, 'keydown', event => {
            const target = event.target as Node | null;
            if (!target || (!this.child.containerEl.contains(target) && !this.active?.toolbar.contains(target))) return;
            if (event.isComposing) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && this.child.file) {
                event.preventDefault(); event.stopImmediatePropagation(); void this.saveAll();
            }
            if (event.key === 'Escape') { this.cancelCurrent(); this.setPlacing(false); }
        }, true);
        this.registerDomEvent(this.child.containerEl.ownerDocument, 'pointerdown', event => {
            const active = this.active, target = event.target as Node | null;
            if (active && target && !active.element.contains(target) && !active.toolbar.contains(target)) this.commitCurrent();
        }, true);
        const layout = () => {
            if (this.layoutFrame !== undefined) return;
            this.layoutFrame = this.child.containerEl.win.requestAnimationFrame(() => { this.layoutFrame = undefined; this.positionToolbar(); });
        };
        this.registerDomEvent(this.child.containerEl.ownerDocument, 'scroll', layout, { capture: true, passive: true });
        this.registerDomEvent(this.child.containerEl.win, 'resize', layout);
        const render = ({ source }: { source: PDFPageView }) => {
            if (this.active?.page.id === source.id && this.active.viewport !== source.viewport) this.commitCurrent();
            void this.targets(source);
        };
        this.plugin.lib.registerPDFEvent('annotationlayerrendered', this.child.pdfViewer.eventBus, this, render);
        this.plugin.lib.registerPDFEvent('pagerendered', this.child.pdfViewer.eventBus, this, render);
        this.child.pdfViewer.pdfViewer?._pages.forEach(page => { void this.targets(page); });
        this.register(this.plugin.freeText.subscribe(path => {
            if (this.child.file?.path !== path) return;
            this.updateStatus();
            for (const page of this.pages.values()) if (this.active?.page.id !== page.id) void this.targets(page);
        }));
        this.updateStatus();
        this.register(() => {
            this.commitCurrent(); this.alive = false; group.remove(); this.setPlacing(false); this.closeEditor();
            window.clearTimeout(this.inputTimer);
            if (this.layoutFrame !== undefined) this.child.containerEl.win.cancelAnimationFrame(this.layoutFrame);
            this.child.containerEl.querySelectorAll('.pdf-sync-note-hit, .pdf-sync-note-preview').forEach(el => el.remove());
        });
    }
    private editable(): boolean {
        if (!this.plugin.lib.isEditable(this.child) || !this.child.file) {
            new Notice('请先开启 Enable PDF editing，并使用笔记库中的 PDF。'); return false;
        }
        if (this.plugin.freeText.state(this.child.file).saving) { new Notice('正在后台保存，可继续阅读，保存后即可再次编辑。'); return false; }
        return true;
    }
    private setPlacing(value: boolean) {
        this.placing = value; this.button?.setAttribute('aria-pressed', String(value));
        this.button?.toggleClass('is-active', value); this.child.containerEl.toggleClass('pdf-plus-text-placement', value);
    }
    private updateStatus() {
        const file = this.child.file; if (!file || !this.label) return;
        const state = this.plugin.freeText.state(file);
        this.label.textContent = state.saving ? '正在保存…' : state.error ? '重试保存' : state.count ? `保存更改 · ${state.count}` : '已保存';
        this.saveButton.disabled = state.saving || (!state.count && !this.active);
        this.saveButton.toggleClass('has-changes', !!state.count);
        this.saveButton.setAttribute('title', state.error ?? (state.count ? '写入 PDF · Ctrl/Cmd+S' : '文字更改已保存到 PDF'));
    }
    private click(event: MouseEvent) {
        const target = event.target as Element | null;
        if (!target?.closest || target.closest('.pdf-sync-editor, .pdf-sync-floating-toolbar')) return;
        const hit = target.closest<HTMLElement>('.pdf-sync-note-hit, .pdf-sync-note-preview');
        if (hit) {
            if (!this.editable()) return;
            event.preventDefault(); event.stopImmediatePropagation();
            const page = this.pages.get(Number(hit.dataset.page));
            const box = hit.dataset.box ? JSON.parse(hit.dataset.box) as TextBox : null;
            if (page && box) this.openEditor(page, box, hit.dataset.key!);
            return;
        }
        if (!this.placing) return;
        const pageEl = target.closest<HTMLElement>('.page[data-page-number]');
        if (!pageEl || !this.editable() || !this.commitCurrent()) return;
        const page = this.child.getPage(Number(pageEl.dataset.pageNumber)); if (!page) return;
        if (page.viewport.rotation % 360) { new Notice('请先将页面显示旋转恢复为 0°。'); return; }
        event.preventDefault(); event.stopImmediatePropagation();
        const bounds = page.div.getBoundingClientRect(), width = 20 * page.viewport.scale;
        const x = Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - width - 8));
        const y = Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - 60));
        const p1 = page.getPagePoint(x, y), p2 = page.getPagePoint(x + width, y + 32 * page.viewport.scale);
        this.openEditor(page, { page: page.id, rect: [p1[0], p2[1], p2[0], p1[1]], text: '', fontSize: 12, color: '#202124' }, `new:${crypto.randomUUID()}`);
    }
    private async targets(page: PDFPageView) {
        const file = this.child.file;
        if (!page?.pdfPage || !file || !this.alive || this.active?.page.id === page.id) return;
        this.pages.set(page.id, page); this.updateStatus();
        let promise = this.metadata.get(page.pdfPage);
        if (!promise) {
            promise = page.pdfPage.getAnnotations().then(items => items.filter((a: any) => a.subtype === 'FreeText' && a.rect && a.id).map((a: any) => boxFromAnnotation(a, page.id)));
            this.metadata.set(page.pdfPage, promise);
        }
        const notes = await promise.catch(() => []);
        if (!this.alive || this.child.file?.path !== file.path || this.active?.page.id === page.id) return;
        page.div.querySelectorAll('.pdf-sync-note-hit, .pdf-sync-note-preview').forEach(el => el.remove());
        const changes = new Map(this.plugin.freeText.changes(file).filter(op => op.box.page === page.id).map(op => [op.key, op]));
        for (const note of notes) {
            const key = note.id!;
            const change = changes.get(key);
            if (change) {
                this.preview(page, note, key, true); // Mask the previous appearance until the batch is saved.
                if (!change.deleted) this.preview(page, change.box, key);
                changes.delete(key);
            } else this.hit(page, this.plugin.freeText.cached(file, key) ?? note, key);
        }
        for (const [key, change] of changes) if (!change.deleted) this.preview(page, change.box, key);
        if (notes.length) void this.plugin.freeText.preload(file).catch(error => console.debug('PDF text index:', error));
    }
    private async highlightSelection() {
        if (!this.editable()) return;
        const selection = this.child.containerEl.win.getSelection();
        const range = selection && this.plugin.lib.copyLink.getPageAndTextRangeFromSelection(selection);
        if (!selection || !range?.selection || this.plugin.lib.getPDFViewerChildFromSelection(selection) !== this.child) {
            new Notice('请先选中 PDF 正文，再点击高亮按钮。'); return;
        }
        const file = this.child.file!;
        if (this.active || this.plugin.freeText.state(file).count) {
            new Notice('请先保存文字草稿，再高亮正文。'); return;
        }
        const { beginIndex, beginOffset, endIndex, endOffset } = range.selection;
        try {
            const result = await this.plugin.lib.highlight.writeFile.addAnnotationToTextRange(
                (target, page, rects) => this.plugin.lib.highlight.writeFile.pdflib.addHighlightAnnotation(target, page, rects),
                this.child, range.page, beginIndex, beginOffset, endIndex, endOffset);
            if (result?.annotationID) new Notice('高亮已写入 PDF，请等待文件同步完成。');
            else new Notice('未能添加高亮，请确认已选中可识别的 PDF 正文。');
        } catch (error) { new Notice(`高亮保存失败：${error instanceof Error ? error.message : String(error)}`); }
    }
    /** Repaint only the old annotation's region without annotations, preserving page images and colors. */
    private restorePageRegion(target: HTMLElement, page: PDFPageView, box: TextBox) {
        let cache = this.cleanRegions.get(page.pdfPage);
        if (!cache) { cache = new Map(); this.cleanRegions.set(page.pdfPage, cache); }
        const key = `${box.id}:${box.rect.join(',')}:${page.viewport.scale}`;
        let rendered = cache.get(key);
        if (!rendered) {
            const rect = page.viewport.convertToViewportRectangle(box.rect);
            const x = Math.min(rect[0], rect[2]), y = Math.min(rect[1], rect[3]);
            const width = Math.abs(rect[2] - rect[0]), height = Math.abs(rect[3] - rect[1]);
            const canvas = page.div.ownerDocument.createElement('canvas');
            const ratio = Math.min(2, page.div.win.devicePixelRatio || 1);
            canvas.width = Math.ceil(width * ratio); canvas.height = Math.ceil(height * ratio);
            const context = canvas.getContext('2d');
            if (!context) return;
            const task = page.pdfPage.render({ canvas, canvasContext: context, viewport: page.viewport,
                transform: [ratio, 0, 0, ratio, -x * ratio, -y * ratio], annotationMode: 0 });
            rendered = task.promise.then(() => canvas);
            cache.set(key, rendered);
            this.register(() => task.cancel());
        }
        void rendered.then(canvas => {
            if (!target.isConnected) return;
            const copy = canvas.cloneNode() as HTMLCanvasElement;
            copy.getContext('2d')?.drawImage(canvas, 0, 0);
            copy.style.width = '100%'; copy.style.height = '100%'; target.append(copy);
        }).catch(error => { cache!.delete(key); console.debug('PDF clean annotation region:', error); });
    }
    private position(el: HTMLElement, page: PDFPageView, box: TextBox) {
        const rect = page.viewport.convertToViewportRectangle(box.rect);
        el.style.left = `${Math.min(rect[0], rect[2])}px`; el.style.top = `${Math.min(rect[1], rect[3])}px`;
        el.style.width = `${Math.abs(rect[2] - rect[0])}px`; el.style.minHeight = `${Math.abs(rect[3] - rect[1])}px`;
    }
    private hit(page: PDFPageView, box: TextBox, key: string) {
        const el = page.div.createEl('button', { cls: 'pdf-sync-note-hit', attr: { 'aria-label': '编辑文字批注', type: 'button' } });
        this.position(el, page, box); el.dataset.box = JSON.stringify(box); el.dataset.key = key; el.dataset.page = String(page.id);
    }
    private preview(page: PDFPageView, box: TextBox, key: string, mask = false) {
        const el = page.div.createDiv({ cls: 'pdf-sync-note-preview' + (mask ? ' is-mask' : '') });
        this.position(el, page, box);
        if (mask) this.restorePageRegion(el, page, box);
        if (!mask) {
            el.textContent = box.text; el.style.color = box.color; el.style.fontSize = `${box.fontSize * page.viewport.scale}px`;
            el.style.padding = `${4 * page.viewport.scale}px`; el.style.minHeight = ''; el.style.width = 'max-content'; el.style.maxWidth = `${Math.max(20, page.div.clientWidth - el.offsetLeft)}px`;
            el.dataset.box = JSON.stringify(box); el.dataset.key = key; el.dataset.page = String(page.id);
            el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0'); el.setAttribute('aria-label', '编辑未保存的文字批注');
            el.addEventListener('keydown', e => { if (e.key === 'Enter' && this.editable()) this.openEditor(page, box, key); });
        }
    }
    private openEditor(page: PDFPageView, source: TextBox, key: string) {
        if (!this.commitCurrent() || page.viewport.rotation % 360 || !this.child.file) return;
        const file = this.child.file;
        const previous = this.plugin.freeText.changes(file).find(op => op.key === key);
        const box = previous?.box ?? (source.id ? this.plugin.freeText.cached(file, source.id) : undefined) ?? source;
        page.div.querySelectorAll<HTMLElement>('.pdf-sync-note-hit, .pdf-sync-note-preview:not(.is-mask)').forEach(el => {
            if (el.dataset.key === key) el.remove();
        });
        if (source.id) this.preview(page, source, key, true);
        const element = page.div.createDiv({ cls: 'pdf-sync-editor' });
        this.position(element, page, box); element.style.minHeight = ''; element.style.width = 'max-content';
        element.setAttribute('role', 'group'); element.setAttribute('aria-label', 'PDF 文字批注');
        element.style.maxWidth = `${Math.max(20, page.div.clientWidth - element.offsetLeft)}px`;
        const content = element.createDiv({ cls: 'pdf-sync-editor-content', attr: { contenteditable: 'plaintext-only', role: 'textbox', 'aria-label': '文字内容', 'aria-multiline': 'true', 'data-placeholder': '' } });
        content.textContent = box.text;
        const bar = page.div.ownerDocument.body.createDiv({ cls: 'pdf-sync-floating-toolbar', attr: { role: 'toolbar', 'aria-label': '文字格式' } });
        const active: ActiveEditor = { key, box: { ...box, rect: [...box.rect] }, page, viewport: page.viewport, file, element, content, toolbar: bar,
            dirty: false, composing: false, previous, removeCommitter: () => {}, interactions: [] };
        this.active = active;
        this.child.containerEl.addClass('pdf-sync-editing');
        active.removeCommitter = this.plugin.freeText.addCommitter(file.path, () => this.commitCurrent());
        const icon = (name: string, label: string, action?: () => void) => {
            const button = bar.createEl('button', { cls: 'pdf-sync-format-button', attr: { type: 'button', 'aria-label': label, title: label } });
            setIcon(button, name); if (action) button.addEventListener('click', action); return button;
        };
        const grip = icon('grip-vertical', '拖动文字框'); grip.addClass('pdf-sync-text-grip');
        const sizeGroup = bar.createDiv({ cls: 'pdf-sync-font-size' });
        const minus = sizeGroup.createEl('button', { text: '−', attr: { type: 'button', 'aria-label': '减小字号' } });
        const size = sizeGroup.createEl('input', { type: 'number', attr: { min: '6', max: '72', 'aria-label': '字号' } }); size.value = String(Math.round(box.fontSize));
        const plus = sizeGroup.createEl('button', { text: '+', attr: { type: 'button', 'aria-label': '增大字号' } });
        const setSize = (value: number) => {
            if (!Number.isFinite(value)) return;
            active.box.fontSize = Math.max(6, Math.min(72, value)); active.box.autoFont = false; size.value = String(active.box.fontSize);
            this.styleContent(active); active.dirty = true; this.checkpoint(); this.positionToolbar();
        };
        minus.addEventListener('click', () => setSize(active.box.fontSize - 1)); plus.addEventListener('click', () => setSize(active.box.fontSize + 1));
        size.addEventListener('change', () => setSize(Number(size.value)));
        bar.createDiv({ cls: 'pdf-sync-toolbar-divider' });
        const colors = bar.createDiv({ cls: 'pdf-sync-color-swatches', attr: { 'aria-label': '文字颜色' } });
        const choose = (color: string) => {
            active.box.color = color; active.box.autoColor = false; active.dirty = true; this.styleContent(active); this.checkpoint();
            colors.querySelectorAll<HTMLElement>('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
        };
        for (const [color, name] of [['#202124', '黑色'], ['#d93025', '红色'], ['#1a73e8', '蓝色'], ['#188038', '绿色'], ['#a142f4', '紫色']]) {
            const swatch = colors.createEl('button', { cls: 'pdf-sync-color-swatch', attr: { type: 'button', 'aria-label': name, 'aria-pressed': String(box.color === color) } });
            swatch.style.setProperty('--swatch-color', color); swatch.dataset.color = color; swatch.addEventListener('click', () => choose(color));
        }
        const custom = colors.createEl('input', { type: 'color', cls: 'pdf-sync-custom-color', attr: { 'aria-label': '自定义文字颜色', title: '自定义颜色' } }); custom.value = box.color;
        custom.addEventListener('input', () => choose(custom.value));
        bar.createDiv({ cls: 'pdf-sync-toolbar-divider' });
        icon('trash-2', '删除文字框', () => { this.plugin.freeText.stage(file, key, active.box, true); this.closeEditor(); this.refresh(); });
        icon('check', '完成编辑（写入 PDF 请点保存更改）', () => this.commitCurrent()).addClass('pdf-sync-format-done');
        content.addEventListener('compositionstart', () => { active.composing = true; });
        content.addEventListener('compositionend', () => { active.composing = false; active.dirty = true; this.checkpoint(); });
        content.addEventListener('input', () => {
            active.dirty = true; window.clearTimeout(this.inputTimer);
            this.inputTimer = window.setTimeout(() => { if (!active.composing) this.checkpoint(); }, 120);
            this.positionToolbar();
        });
        content.addEventListener('keydown', event => {
            if (event.isComposing) return;
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); this.commitCurrent(); }
            event.stopPropagation();
        });
        content.addEventListener('paste', event => {
            event.preventDefault();
            const text = event.clipboardData?.getData('text/plain') ?? '';
            content.ownerDocument.execCommand('insertText', false, text); // Native insertion keeps caret and browser undo history.
        });
        const drag = interact(grip).draggable({ listeners: { move: (event: any) => {
            const maxX = Math.max(0, page.div.clientWidth - element.offsetWidth), maxY = Math.max(0, page.div.clientHeight - element.offsetHeight);
            element.style.left = `${Math.max(0, Math.min(maxX, element.offsetLeft + event.dx))}px`;
            element.style.top = `${Math.max(0, Math.min(maxY, element.offsetTop + event.dy))}px`;
            active.dirty = true; this.positionToolbar();
        }, end: () => this.checkpoint() } });
        const left = element.createDiv({ cls: 'pdf-sync-resize-handle is-left', attr: { 'aria-hidden': 'true' } });
        const right = element.createDiv({ cls: 'pdf-sync-resize-handle is-right', attr: { 'aria-hidden': 'true' } });
        const resize = interact(element).resizable({ edges: { left, right, top: false, bottom: false }, listeners: { move: (event: any) => {
            const x = Math.max(0, element.offsetLeft + event.deltaRect.left);
            element.style.left = `${x}px`; element.style.width = `${Math.max((active.box.fontSize + 8) * active.viewport.scale, Math.min(event.rect.width, page.div.clientWidth - x))}px`;
            active.dirty = true; this.positionToolbar();
        }, end: () => this.checkpoint() } });
        active.interactions.push(drag, resize);
        this.styleContent(active); this.positionToolbar(); this.updateStatus(); content.focus();
        this.child.destroyAnnotationPopup(); queueMicrotask(() => { if (this.alive) this.child.destroyAnnotationPopup(); });
        if (box.id && box.autoFont) void this.plugin.freeText.preload(file).then(() => {
            if (this.active !== active) return;
            const actual = this.plugin.freeText.cached(file, box.id!); if (!actual) return;
            active.box.source = actual.source;
            if (active.box.autoFont) { active.box.fontSize = actual.fontSize; size.value = String(actual.fontSize); }
            if (active.box.autoColor) active.box.color = actual.color;
            this.styleContent(active); this.positionToolbar();
        }).catch(() => {});
    }
    private styleContent(active: ActiveEditor) {
        active.content.style.fontSize = `${active.box.fontSize * active.viewport.scale}px`;
        active.content.style.color = active.box.color; active.content.style.padding = `${4 * active.viewport.scale}px`;
        active.element.style.minWidth = `${(active.box.fontSize + 8) * active.viewport.scale}px`;
    }
    private checkpoint() {
        const active = this.active; if (!active || !active.dirty || active.composing) return;
        const { element, content, viewport } = active;
        const p1 = viewport.convertToPdfPoint(element.offsetLeft, element.offsetTop);
        const p2 = viewport.convertToPdfPoint(element.offsetLeft + element.offsetWidth, element.offsetTop + element.offsetHeight);
        active.box.rect = [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])];
        active.box.text = content.innerText.replace(/\r\n?/g, '\n');
        this.plugin.freeText.stage(active.file, active.key, active.box, !active.box.text.trim());
        this.updateStatus();
    }
    private commitCurrent(): boolean {
        if (this.active?.composing) return false;
        this.checkpoint(); this.closeEditor(); this.refresh(); return true;
    }
    private cancelCurrent() {
        const active = this.active; if (!active || active.composing) return;
        if (active.dirty) this.plugin.freeText.restore(active.file, active.key, active.previous);
        this.closeEditor(); this.refresh();
    }
    private closeEditor() {
        window.clearTimeout(this.inputTimer);
        const active = this.active; this.active = null; this.child.containerEl.removeClass('pdf-sync-editing'); if (!active) return;
        active.removeCommitter(); active.interactions.forEach(i => i.unset()); active.element.remove(); active.toolbar.remove();
    }
    private refresh() { this.updateStatus(); for (const page of this.pages.values()) void this.targets(page); }
    private positionToolbar() {
        const active = this.active; if (!active) return;
        const rect = active.element.getBoundingClientRect(), bar = active.toolbar, win = active.element.win;
        const width = bar.offsetWidth, height = bar.offsetHeight;
        bar.style.left = `${Math.max(8, Math.min(win.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
        const above = rect.top - height - 12;
        bar.style.top = `${Math.max(8, Math.min(win.innerHeight - height - 8, above >= 8 ? above : rect.bottom + 12))}px`;
    }
    private async saveAll() {
        if (!this.commitCurrent() || !this.child.file) return;
        this.setPlacing(false);
        try { await this.plugin.freeText.savePending(this.child.file); }
        catch (error) { new Notice(String(error.message ?? error)); }
    }
}

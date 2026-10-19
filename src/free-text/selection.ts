import { Component, Notice, setIcon } from 'obsidian';
import type PDFPlus from 'main';
import type { PDFViewerChild, PDFPageView, Rect } from 'typings';

export class PDFSelectionTools extends Component {
    private region = false;
    private selecting = false;
    private buttons: HTMLElement[] = [];
    private drag: { page: PDFPageView; x: number; y: number; lastX: number; lastY: number; pointer: number; box: HTMLElement } | null = null;
    constructor(private plugin: PDFPlus, private child: PDFViewerChild, private toolbar: HTMLElement) { super(); }
    onload() {
        const text = this.toolbar.createEl('button', { cls: 'clickable-icon', attr: { type: 'button', 'aria-label': '选择 PDF 正文', title: '选择文本模式：拖动选择正文，再点击荧光笔' } }); setIcon(text, 'text-cursor');
        const region = this.toolbar.createEl('button', { cls: 'pdf-sync-region-button', attr: { type: 'button', 'aria-label': '框选高亮（支持扫描 PDF）', title: '拖动框选高亮区域；任意模式下 Alt+拖动也可框选' } }); setIcon(region.createSpan(), 'scan-line'); region.createSpan({ text: '框选高亮' });
        const color = this.toolbar.createEl('input', { type: 'color', cls: 'pdf-sync-highlight-color', attr: { 'aria-label': '高亮颜色', title: '选择正文与框选的高亮颜色' } });
        this.plugin.freeText.initialize(); color.value = this.plugin.freeText.highlightColor;
        this.registerDomEvent(color, 'input', () => { this.plugin.freeText.setHighlightColor(color.value); this.child.containerEl.style.setProperty('--pdf-sync-highlight-color', color.value); });
        const undo = this.toolbar.createEl('button', { cls: 'clickable-icon', attr: { type: 'button', 'aria-label': '撤销上一步 · Ctrl+Z', title: '撤销上一步 · Ctrl+Z' } }); setIcon(undo, 'undo-2');
        this.registerDomEvent(undo, 'click', () => { if (this.child.file) this.plugin.freeText.undoHighlight(this.child.file); });
        this.buttons.push(text, region, color, undo);
        const previews = () => this.renderDrafts();
        this.plugin.lib.registerPDFEvent('pagerendered', this.child.pdfViewer.eventBus, this, previews);
        this.plugin.lib.registerPDFEvent('annotationlayerrendered', this.child.pdfViewer.eventBus, this, previews);
        this.register(this.plugin.freeText.subscribe(path => { if (path === this.child.file?.path) previews(); }));
        previews();
        const mode = this.plugin.app.loadLocalStorage?.('pdf-plus-highlight-mode');
        this.region = mode !== 'text' && mode !== 'none'; this.selecting = mode === 'text'; this.update(text, region);
        this.registerDomEvent(text, 'click', () => { this.stop(); this.selecting = !this.selecting; this.region = false; this.update(text, region); if (this.selecting) void this.describeTextLayer(text, region); });
        this.registerDomEvent(region, 'click', () => { this.stop(); this.region = !this.region; this.selecting = false; this.update(text, region); if (this.region) new Notice('框选高亮已开启：按住鼠标拖出矩形，松开暂存，可连续框选；最后点击“保存更改”。Esc 退出。'); });
        // Entering the text annotation tool restores annotation hit targets.
        this.registerDomEvent(this.toolbar, 'click', event => { if ((event.target as Element)?.closest('.pdf-plus-free-text-button')) { this.stop(); this.region = this.selecting = false; this.update(text, region); } }, true);
        this.registerDomEvent(this.child.containerEl, 'pointerdown', event => {
            if ((!this.region && !event.altKey) || event.button !== 0) return;
            const element = (event.target as Element)?.closest<HTMLElement>('.page[data-page-number]');
            if (!element || !this.child.file) return;
            if (!this.plugin.lib.isEditable(this.child)) { new Notice('请先在 PDF++ Sync 设置中开启 Enable PDF editing。'); return; }
            const page = this.child.getPage(Number(element.dataset.pageNumber)); if (!page) return;
            event.preventDefault(); event.stopImmediatePropagation();
            this.child.containerEl.setAttribute('tabindex', '-1'); this.child.containerEl.focus();
            const bounds = page.div.getBoundingClientRect(), x = event.clientX-bounds.left, y = event.clientY-bounds.top;
            const box = page.div.createDiv({ cls: 'pdf-sync-highlight-region' });
            this.drag = { page, x, y, lastX: x, lastY: y, pointer: event.pointerId, box }; this.draw();
            this.child.containerEl.setPointerCapture(event.pointerId);
        }, true);
        this.registerDomEvent(this.child.containerEl, 'pointermove', event => {
            const d = this.drag; if (!d || event.pointerId !== d.pointer) return;
            event.preventDefault(); const bounds = d.page.div.getBoundingClientRect();
            d.lastX = Math.max(0, Math.min(bounds.width, event.clientX-bounds.left)); d.lastY = Math.max(0, Math.min(bounds.height, event.clientY-bounds.top)); this.draw();
        }, true);
        this.registerDomEvent(this.child.containerEl, 'pointerup', event => {
            const d = this.drag; if (!d || event.pointerId !== d.pointer) return;
            event.preventDefault(); event.stopImmediatePropagation();
            const p1 = d.page.getPagePoint(d.x,d.y), p2 = d.page.getPagePoint(d.lastX,d.lastY);
            this.stop(); if (Math.abs(d.lastX-d.x) < 3 || Math.abs(d.lastY-d.y) < 3) return;
            const rect: Rect = [Math.min(p1[0],p2[0]),Math.min(p1[1],p2[1]),Math.max(p1[0],p2[0]),Math.max(p1[1],p2[1])];
            const file = this.child.file; if (!file) return;
            try { this.plugin.freeText.stageHighlight(file, d.page.id, [rect]); }
            catch (error) { new Notice(`高亮暂存失败：${error.message ?? error}`); }
        }, true);
        this.registerDomEvent(this.child.containerEl, 'pointercancel', () => this.stop());
        this.registerDomEvent(this.child.containerEl, 'keydown', event => { if (event.key === 'Escape') { this.stop(); this.region = this.selecting = false; this.update(text, region); } });
        this.register(() => { this.stop(); this.buttons.forEach(b => b.remove()); this.child.containerEl.removeClass('pdf-sync-text-selection','pdf-sync-region-mode'); this.child.containerEl.querySelectorAll('.pdf-sync-highlight-draft').forEach(el=>el.remove()); });
    }
    private renderDrafts() {
        this.child.containerEl.querySelectorAll('.pdf-sync-highlight-draft').forEach(el=>el.remove());
        const file = this.child.file; if (!file) return;
        for (const op of this.plugin.freeText.changes(file)) {
            if (op.kind !== 'highlight' || op.deleted || op.box.id) continue;
            const page = this.child.getPage(op.box.page); if (!page?.div || !page.viewport) continue;
            for (const rect of op.rects ?? []) {
                const [x0,y0,x1,y1] = page.viewport.convertToViewportRectangle(rect);
                const el = page.div.createDiv({ cls: 'pdf-sync-highlight-draft' });
                Object.assign(el.style, { left: `${Math.min(x0,x1)}px`, top: `${Math.min(y0,y1)}px`, width: `${Math.abs(x1-x0)}px`, height: `${Math.abs(y1-y0)}px`, backgroundColor: op.box.color, opacity: String(op.opacity ?? 0.35) });
            }
        }
    }
    private update(text: HTMLElement, region: HTMLElement) {
        this.plugin.app.saveLocalStorage?.('pdf-plus-highlight-mode', this.region ? 'region' : this.selecting ? 'text' : 'none');
        if ((this.selecting || this.region) && this.child.palette?.cropButtonEl?.hasClass('is-active')) this.child.palette.cropButtonEl.click();
        this.child.containerEl.toggleClass('pdf-sync-text-selection',this.selecting); this.child.containerEl.toggleClass('pdf-sync-region-mode',this.region);
        this.child.containerEl.style.setProperty('--pdf-sync-highlight-color',this.plugin.freeText.highlightColor);
        text.setAttribute('aria-pressed',String(this.selecting)); region.setAttribute('aria-pressed',String(this.region));
    }
    private draw() {
        const d = this.drag; if (!d) return;
        Object.assign(d.box.style,{ left: `${Math.min(d.x,d.lastX)}px`, top: `${Math.min(d.y,d.lastY)}px`, width: `${Math.abs(d.lastX-d.x)}px`, height: `${Math.abs(d.lastY-d.y)}px` });
    }
    private stop() {
        const d = this.drag; this.drag = null; d?.box.remove();
        if (d && this.child.containerEl.hasPointerCapture(d.pointer)) this.child.containerEl.releasePointerCapture(d.pointer);
    }
    private async describeTextLayer(text: HTMLElement, region: HTMLElement) {
        const page = this.child.getPage(this.child.pdfViewer.pdfViewer?.currentPageNumber ?? 1); if (!page?.pdfPage) return;
        try {
            const content = await page.pdfPage.getTextContent();
            if (!this.selecting) return;
            if (!content.items.some(item => 'str' in item && item.str.trim())) {
                this.selecting = false; this.region = true; this.update(text, region);
                new Notice('此页是扫描页，已切换为框选高亮。按住鼠标拖出矩形，松开即可标亮；Esc 取消。', 7000);
            }
            else { await page.textLayer?.render(); new Notice('已切换文本选择模式，拖动正文选字后点击荧光笔。'); }
        } catch { new Notice('文字层暂未就绪，请等待页面加载，或使用框选高亮。'); }
    }
}

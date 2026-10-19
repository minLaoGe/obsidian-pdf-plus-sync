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
        const region = this.toolbar.createEl('button', { cls: 'pdf-sync-region-button', attr: { type: 'button', 'aria-label': '框选高亮（支持扫描 PDF）', title: '拖动框选高亮区域，无需文字层' } }); setIcon(region.createSpan(), 'scan-line'); region.createSpan({ text: '框选高亮' });
        this.buttons.push(text, region);
        this.registerDomEvent(text, 'click', () => { this.stop(); this.selecting = !this.selecting; this.region = false; this.update(text, region); if (this.selecting) void this.describeTextLayer(text, region); });
        this.registerDomEvent(region, 'click', () => { this.stop(); this.region = !this.region; this.selecting = false; this.update(text, region); if (this.region) new Notice('框选高亮已开启：按住鼠标拖出矩形，松开保存。Esc 取消。'); });
        // Entering the text annotation tool restores annotation hit targets.
        this.registerDomEvent(this.toolbar, 'click', event => { if ((event.target as Element)?.closest('.pdf-plus-free-text-button')) { this.stop(); this.region = this.selecting = false; this.update(text, region); } }, true);
        this.registerDomEvent(this.child.containerEl, 'pointerdown', event => {
            if (!this.region || event.button !== 0) return;
            const element = (event.target as Element)?.closest<HTMLElement>('.page[data-page-number]');
            if (!element || !this.child.file) return;
            if (!this.plugin.lib.isEditable(this.child)) { new Notice('请先在 PDF++ Sync 设置中开启 Enable PDF editing。'); return; }
            if (this.plugin.freeText.state(this.child.file).saving) { new Notice('PDF 正在保存，请稍后再框选高亮。'); return; }
            if (this.plugin.freeText.state(this.child.file).count) { new Notice('请先保存文字草稿，再框选高亮。'); return; }
            const page = this.child.getPage(Number(element.dataset.pageNumber)); if (!page) return;
            event.preventDefault(); event.stopImmediatePropagation();
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
            this.region = false; this.update(text, region);
            void this.plugin.lib.highlight.writeFile.pdflib.addHighlightAnnotation(file, d.page.id, [rect])
                .then(() => new Notice('区域高亮已写入 PDF，请等待文件同步完成。'))
                .catch(error => new Notice(`高亮失败：${error.message ?? error}`));
        }, true);
        this.registerDomEvent(this.child.containerEl, 'pointercancel', () => this.stop());
        this.registerDomEvent(this.child.containerEl, 'keydown', event => { if (event.key === 'Escape') { this.stop(); this.region = this.selecting = false; this.update(text, region); } });
        this.register(() => { this.stop(); this.buttons.forEach(b => b.remove()); this.child.containerEl.removeClass('pdf-sync-text-selection','pdf-sync-region-mode'); });
    }
    private update(text: HTMLElement, region: HTMLElement) {
        if ((this.selecting || this.region) && this.child.palette?.cropButtonEl?.hasClass('is-active')) this.child.palette.cropButtonEl.click();
        this.child.containerEl.toggleClass('pdf-sync-text-selection',this.selecting); this.child.containerEl.toggleClass('pdf-sync-region-mode',this.region);
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

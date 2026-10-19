import { Component, Notice, setIcon, setTooltip } from 'obsidian';
import type PDFPlus from 'main';
import type { PDFPageView, PDFViewerChild } from 'typings';
import type { TextBox } from './pdf';

/** A one-shot placement tool and accessible edit targets for standard FreeText annotations. */
export class FreeTextTool extends Component {
    private placing = false;
    private button: HTMLElement;
    private editor: HTMLElement | null = null;
    private busy = false;
    private epoch = 0;
    private alive = true;
    constructor(private plugin: PDFPlus, private child: PDFViewerChild, private toolbar: HTMLElement) { super(); }
    onload() {
        this.button = this.toolbar.createDiv({ cls: 'clickable-icon pdf-plus-free-text-button' });
        this.button.setAttribute('role','button');
        this.button.setAttribute('tabindex','0');
        this.button.setAttribute('aria-label','在 PDF 页面添加文字');
        setIcon(this.button,'lucide-type');
        setTooltip(this.button,'添加文字：点击页面放置，点击已有文字再次编辑');
        this.registerDomEvent(this.button,'click',()=>this.toggle());
        this.registerDomEvent(this.button,'keydown',e=>{ if (e.key==='Enter' || e.key===' ') { e.preventDefault(); this.toggle(); } });
        this.registerDomEvent(this.child.containerEl,'click',e=>{
            if (!this.placing || !e.target || !(e.target as Element).closest) return;
            const target = e.target as Element;
            const pageEl=target.closest<HTMLElement>('.page[data-page-number]');
            if (!pageEl || target.closest('.pdf-plus-inline-text-editor')) return;
            const pageNumber=Number(pageEl.dataset.pageNumber);
            const page=this.child.getPage(pageNumber);
            if (!page) return;
            if (page.viewport.rotation % 360 !== 0) { new Notice('请先将页面显示旋转恢复为 0°，再放置文字。'); return; }
            e.preventDefault(); e.stopImmediatePropagation();
            this.setPlacing(false);
            const bounds=page.div.getBoundingClientRect();
            const scale=page.viewport.scale;
            const width=Math.min(220*scale,bounds.width-12);
            const left=Math.max(4,Math.min(e.clientX-bounds.left,bounds.width-width-4));
            const top=Math.max(4,Math.min(e.clientY-bounds.top,bounds.height-80));
            const p1=page.getPagePoint(left,top),p2=page.getPagePoint(left+width,top+36*scale);
            const rect: TextBox['rect']=[Math.min(p1[0],p2[0]),Math.min(p1[1],p2[1]),Math.max(p1[0],p2[0]),Math.max(p1[1],p2[1])];
            this.openEditor(page,{page:pageNumber,rect,text:'',fontSize:12,color:'#222222'});
        },true);
        this.registerDomEvent(this.child.containerEl.ownerDocument,'keydown',e=>{
            if (e.key==='Escape') { this.setPlacing(false); if (!this.busy) this.closeEditor(); }
        });
        const render=({source}:{source:PDFPageView})=>{ void this.targets(source); };
        this.plugin.lib.registerPDFEvent('annotationlayerrendered',this.child.pdfViewer.eventBus,this,render);
        this.plugin.lib.registerPDFEvent('pagerendered',this.child.pdfViewer.eventBus,this,render);
        this.child.pdfViewer.pdfViewer?._pages.forEach(page=>{ void this.targets(page); });
        this.register(()=>{
            this.alive=false; this.epoch++;
            this.button.remove();this.setPlacing(false);this.closeEditor();
            this.child.containerEl.querySelectorAll('.pdf-plus-text-hit').forEach(el=>el.remove());
        });
    }
    private editable(): boolean {
        if (this.plugin.lib.isEditable(this.child) && this.child.file) return true;
        new Notice('请在插件设置中开启 Enable PDF editing，并使用笔记库中的 PDF。');
        return false;
    }
    toggle() {
        if (!this.editable() || this.busy) return;
        this.closeEditor();this.setPlacing(!this.placing);
        if (this.placing) new Notice('点击 PDF 页面任意位置输入文字；Esc 退出。');
    }
    private setPlacing(value:boolean) {
        this.placing=value;
        this.button?.toggleClass('is-active',value);
        this.button?.setAttribute('aria-pressed',String(value));
        this.child.containerEl.toggleClass('pdf-plus-text-placement',value);
    }
    private async targets(page:PDFPageView) {
        if (!page?.pdfPage || !this.alive) return;
        const file=this.child.file;
        const annotations=await page.pdfPage.getAnnotations().catch(()=>[]);
        if (!this.alive || this.child.file!==file) return;
        page.div.querySelectorAll('.pdf-plus-text-hit').forEach(el=>el.remove());
        for (const annotation of annotations) {
            if (annotation.subtype!=='FreeText' || !annotation.rect || typeof annotation.id!=='string') continue;
            const viewport=page.viewport.convertToViewportRectangle(annotation.rect);
            const left=Math.min(viewport[0],viewport[2]),top=Math.min(viewport[1],viewport[3]);
            const hit=page.div.createEl('button',{cls:'pdf-plus-text-hit',attr:{'aria-label':'编辑文字批注','title':'点击编辑文字批注'}});
            hit.style.cssText=`left:${left}px;top:${top}px;width:${Math.abs(viewport[2]-viewport[0])}px;height:${Math.abs(viewport[3]-viewport[1])}px;`;
            hit.addEventListener('click',event=>{
                event.preventDefault();event.stopPropagation();
                if (!this.editable() || this.busy || this.placing || !file) return;
                const epoch=++this.epoch;
                void this.plugin.freeText.read(file,page.id,annotation.id).then(box=>{
                    if (this.alive && epoch===this.epoch && this.child.file===file) this.openEditor(page,box);
                }).catch(error=>new Notice(String(error.message??error)));
            });
        }
    }
    private closeEditor() { this.editor?.remove();this.editor=null; }
    private openEditor(page:PDFPageView,box:TextBox) {
        if (page.viewport.rotation % 360 !== 0) { new Notice('请先将页面显示旋转恢复为 0°，再编辑文字。'); return; }
        this.closeEditor();this.setPlacing(false);
        this.child.destroyAnnotationPopup();
        const file=this.child.file;
        if (!file) return;
        const view=page.viewport.convertToViewportRectangle(box.rect);
        const left=Math.min(view[0],view[2]),top=Math.min(view[1],view[3]);
        const editor=page.div.createDiv({cls:'pdf-plus-inline-text-editor'});
        this.editor=editor;
        editor.setAttribute('role','group');editor.setAttribute('aria-label','编辑 PDF 文字批注');
        const pageWidth=page.div.getBoundingClientRect().width;
        editor.style.left=`${Math.max(0,Math.min(left,pageWidth-180))}px`;
        editor.style.top=`${Math.max(0,top)}px`;
        editor.style.width=`${Math.max(180,Math.min(Math.abs(view[2]-view[0]),pageWidth-8))}px`;
        const area=editor.createEl('textarea',{attr:{'aria-label':'文字内容','placeholder':'在这里输入文字…'}});
        area.value=box.text;
        area.style.fontSize=`${box.fontSize*page.viewport.scale}px`;
        area.style.color=box.color;
        area.style.minHeight=`${Math.max(72,Math.abs(view[3]-view[1]))}px`;
        const controls=editor.createDiv({cls:'pdf-plus-inline-text-controls'});
        const size=controls.createEl('input',{type:'number',attr:{'aria-label':'字号','min':'6','max':'72','title':'字号（PDF 点）'}});
        size.value=String(box.fontSize);
        const color=controls.createEl('input',{type:'color',attr:{'aria-label':'文字颜色','title':'文字颜色'}});color.value=box.color;
        size.addEventListener('input',()=>{ area.style.fontSize=`${Number(size.value)*page.viewport.scale}px`; });
        color.addEventListener('input',()=>{area.style.color=color.value;});
        const save=controls.createEl('button',{text:'保存',cls:'mod-cta'});
        const cancel=controls.createEl('button',{text:'取消'});
        const remove=box.id?controls.createEl('button',{text:'删除',cls:'mod-warning'}):null;
        const setBusy=(value:boolean)=>{
            this.busy=value;
            [area,size,color,save,cancel,remove].forEach(el=>{if(el)el.disabled=value;});
        };
        const persist=async(deleting=false)=>{
            if (this.busy) return;
            if (!this.alive || this.child.file?.path !== file.path) { new Notice('页面已更新，请重新点击文字框编辑。'); return; }
            setBusy(true);
            try {
                if (deleting && box.id) await this.plugin.freeText.remove(file,box.page,box.id);
                else await this.plugin.freeText.save(file,{...box,text:area.value,fontSize:Number(size.value),color:color.value},editor.ownerDocument);
                this.closeEditor();
            } catch(error) { new Notice(String(error.message??error)); }
            finally { setBusy(false); }
        };
        save.addEventListener('click',()=>{void persist();});
        cancel.addEventListener('click',()=>this.closeEditor());
        remove?.addEventListener('click',()=>{void persist(true);});
        editor.addEventListener('keydown',event=>{
            event.stopPropagation();
            if (event.key==='Enter' && (event.metaKey || event.ctrlKey)) {event.preventDefault();void persist();}
            if (event.key==='Escape' && !this.busy) this.closeEditor();
        });
        editor.addEventListener('pointerdown',event=>event.stopPropagation());
        area.focus();
    }
}

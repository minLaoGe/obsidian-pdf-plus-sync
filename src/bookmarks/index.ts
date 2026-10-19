import { Component, Modal, Notice, Setting, setIcon } from 'obsidian';
import type PDFPlus from 'main';
import type { PDFViewerChild } from 'typings';
import { DATA_ROOT, ensureFolder, hashPath } from '../sync/store';

interface Bookmark { schema: 1; id: string; file: string; page: number; title: string; folder: string; updated: number; deleted?: boolean }

/** Each bookmark has its own vault file so adding bookmarks on different devices does not overwrite a shared list. */
export class PDFBookmarks extends Component {
    private panel: HTMLElement;
    private button: HTMLButtonElement;
    private visible = false;
    private generation = 0;
    constructor(private plugin: PDFPlus, private child: PDFViewerChild, private toolbar: HTMLElement) { super(); }
    onload() {
        this.button = this.toolbar.createEl('button', { cls: 'clickable-icon', attr: { type: 'button', 'aria-label': '书签目录', title: '打开 PDF 书签目录' } });
        setIcon(this.button, 'book-marked');
        this.panel = this.child.containerEl.createDiv({ cls: 'pdf-sync-bookmarks' }); this.panel.hidden = true;
        this.registerDomEvent(this.button, 'click', () => { this.visible = !this.visible; this.panel.hidden = !this.visible; this.button.setAttribute('aria-pressed', String(this.visible)); if (this.visible) void this.refresh(); });
        const update = () => { if (this.visible) void this.refresh(); };
        this.registerEvent(this.plugin.app.vault.on('create', update));
        this.registerEvent(this.plugin.app.vault.on('modify', update));
        this.registerEvent(this.plugin.app.vault.on('delete', update));
        this.plugin.lib.registerPDFEvent('pagesloaded', this.child.pdfViewer.eventBus, this, update);
        this.register(() => { this.generation++; this.panel.remove(); this.button.remove(); });
    }
    private root(file: string) { return `${DATA_ROOT}/bookmarks/${hashPath(file)}`; }
    private async write(record: Bookmark) {
        const root = this.root(record.file); await ensureFolder(this.plugin.app.vault, root);
        const path = `${root}/${record.id}.json`, body = JSON.stringify(record, null, 2);
        const file = this.plugin.app.vault.getFileByPath(path);
        if (file) await this.plugin.app.vault.modify(file, body);
        else if (await this.plugin.app.vault.adapter.exists(path)) await this.plugin.app.vault.adapter.write(path, body);
        else await this.plugin.app.vault.create(path, body);
    }
    private edit(record?: Bookmark) {
        const file = this.child.file; if (!file) return;
        const page = record?.page ?? this.child.pdfViewer.pdfViewer?.currentPageNumber ?? 1;
        const modal = new Modal(this.plugin.app); modal.titleEl.setText(record ? '编辑书签' : '添加书签');
        let title = record?.title ?? `第 ${page} 页`, folder = record?.folder ?? '';
        new Setting(modal.contentEl).setName('名称').addText(input => input.setValue(title).onChange(value => title = value));
        new Setting(modal.contentEl).setName('目录').setDesc('例如：第一章/重点；留空放入默认目录').addText(input => input.setValue(folder).onChange(value => folder = value));
        new Setting(modal.contentEl).setName(`第 ${page} 页`).addButton(button => button.setButtonText('保存书签').setCta().onClick(async () => {
            if (!title.trim()) { new Notice('请输入书签名称'); return; }
            button.setDisabled(true);
            try {
                const next: Bookmark = { schema: 1, id: record?.id ?? crypto.randomUUID(), file: file.path, page,
                    title: title.trim().slice(0, 200), folder: folder.split('/').map(s => s.trim()).filter(Boolean).join('/').slice(0, 300), updated: Date.now() };
                await this.write(next);
                this.plugin.freeText.recordExternal(file,
                    async () => { await this.write(record ? { ...record, updated: Date.now() } : { ...next, deleted: true, updated: Date.now() }); await this.refresh(); },
                    async () => { await this.write({ ...next, updated: Date.now() }); await this.refresh(); });
                modal.close(); await this.refresh();
            } catch (error) { new Notice(`书签保存失败：${error.message ?? error}`); button.setDisabled(false); }
        })); modal.open();
    }
    private async refresh() {
        const token = ++this.generation, file = this.child.file;
        this.panel.empty();
        const header = this.panel.createDiv({ cls: 'pdf-sync-bookmarks-header' }); header.createEl('strong', { text: '书签目录' });
        const add = header.createEl('button', { text: '+ 添加当前页' }); add.onclick = () => this.edit();
        const close = header.createEl('button', { text: '×', attr: { 'aria-label': '关闭书签目录' } }); close.onclick = () => { this.visible = false; this.panel.hidden = true; this.button.setAttribute('aria-pressed', 'false'); };
        const list = this.panel.createDiv({ cls: 'pdf-sync-bookmarks-list' });
        if (!file) { list.setText('请先打开笔记库中的 PDF'); return; }
        try {
            const root = this.root(file.path), paths = await this.plugin.app.vault.adapter.exists(root) ? (await this.plugin.app.vault.adapter.list(root)).files : [];
            const values = await Promise.all(paths.filter(path => path.endsWith('.json')).map(async path => {
                try {
                    const b = JSON.parse(await this.plugin.app.vault.adapter.read(path)) as Bookmark;
                    return b.schema === 1 && /^[\w-]{1,80}$/.test(b.id) && b.file === file.path && Number.isSafeInteger(b.page) && b.page > 0 && typeof b.title === 'string' && typeof b.folder === 'string' && !b.deleted ? b : null;
                } catch { return null; }
            }));
            if (token !== this.generation || this.child.file?.path !== file.path) return;
            const bookmarks = values.filter((b): b is Bookmark => !!b).sort((a,b) => a.folder.localeCompare(b.folder) || a.page-b.page || a.title.localeCompare(b.title));
            if (!bookmarks.length) list.createEl('p', { text: '还没有书签。点击“添加当前页”，可按章节分目录收藏。', cls: 'pdf-sync-bookmarks-empty' });
            const folders = new Map<string, HTMLElement>(); folders.set('', list);
            const container = (path: string): HTMLElement => {
                if (folders.has(path)) return folders.get(path)!;
                const parts = path.split('/'), label = parts.pop()!, parent = container(parts.join('/'));
                const details = parent.createEl('details'); details.open = true; details.createEl('summary', { text: label });
                const inner = details.createDiv(); folders.set(path, inner); return inner;
            };
            for (const b of bookmarks) {
                const row = container(b.folder).createDiv({ cls: 'pdf-sync-bookmark-row' });
                const jump = row.createEl('button', { text: `${b.title} · 第 ${b.page} 页`, cls: 'pdf-sync-bookmark-jump' });
                jump.onclick = () => { if (b.page > this.child.pdfViewer.pagesCount) { new Notice('该书签页码已超出 PDF 范围'); return; } this.child.pdfViewer.pdfViewer?.scrollPageIntoView({ pageNumber: b.page }); };
                const edit = row.createEl('button', { attr: { 'aria-label': `编辑书签 ${b.title}` } }); setIcon(edit, 'pencil'); edit.onclick = () => this.edit(b);
                const remove = row.createEl('button', { attr: { 'aria-label': `删除书签 ${b.title}` } }); setIcon(remove, 'trash-2');
                remove.onclick = async () => { try { await this.write({ ...b, deleted: true, updated: Date.now() });
                    this.plugin.freeText.recordExternal(file,
                        async () => { await this.write({ ...b, updated: Date.now() }); await this.refresh(); },
                        async () => { await this.write({ ...b, deleted: true, updated: Date.now() }); await this.refresh(); });
                    await this.refresh(); } catch (e) { new Notice(`删除失败：${e.message ?? e}`); } };
            }
        } catch (error) { if (token === this.generation) list.setText(`书签读取失败：${error.message ?? error}`); }
    }
}

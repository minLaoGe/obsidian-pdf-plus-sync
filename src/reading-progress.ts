import { Component, Notice } from 'obsidian';
import type { TFile } from 'obsidian';
import type PDFPlus from './main';
import type { PDFViewer, PDFViewerComponent, PDFViewExtraState } from './typings';
import { ProgressStore, Progress, ROOT, hashPath } from './sync/store';
export type { Progress } from './sync/store';
export { ROOT, validProgress, latest } from './sync/store';

const signature = (s: PDFViewExtraState) => JSON.stringify([s.page, s.left, s.top, s.zoom]);

export class ReadingProgressSync extends Component {
    restored = new WeakMap<PDFViewerComponent, Progress>();
    readonly store: ProgressStore;
    private device: string = crypto.randomUUID();
    private sessions = new Map<PDFViewerComponent, ReadingSession>();
    private generation = new WeakMap<PDFViewerComponent, object>();
    private status: HTMLElement;
    constructor(readonly plugin: PDFPlus) {
        super();
        this.store = new ProgressStore(plugin.app.vault);
        try {
            const key = `pdf-plus-reading-device:${plugin.app.vault.getName()}`;
            const existing = localStorage.getItem(key);
            if (existing && /^[0-9a-f-]{36}$/.test(existing)) this.device = existing;
            else localStorage.setItem(key, this.device);
        } catch { /* Session ID when persistent local storage is unavailable. */ }
    }
    onload() {
        this.status = this.plugin.addStatusBarItem();
        this.status.setAttribute('title', '点击从已同步的记录恢复 PDF 阅读位置');
        this.registerDomEvent(this.status, 'click', () => { void this.resumeActive(true); });
        this.plugin.addCommand({ id: 'resume-synced-reading-position', name: '恢复已同步的 PDF 阅读进度', callback: () => this.resumeActive(true) });
        this.registerEvent(this.plugin.app.workspace.on('active-leaf-change', () => {
            for (const session of this.sessions.values()) {
                if (!session.active()) session.deactivate();
                else void session.resume(false);
            }
        }));
        const onRecordChanged = (file: { path: string }) => {
            if (!file.path.startsWith(ROOT + '/')) return;
            for (const session of this.sessions.values()) {
                if (session.matchesRecord(file.path)) void session.observeRemote();
            }
        };
        this.registerEvent(this.plugin.app.vault.on('create', onRecordChanged));
        this.registerEvent(this.plugin.app.vault.on('modify', onRecordChanged));
        this.register(() => {
            for (const session of this.sessions.values()) session.dispose();
            this.sessions.clear();
            this.status.remove();
        });
    }
    async initialize() {
        try { await this.store.migrateLegacy(); }
        catch (error) { this.report(error); }
    }
    report(error: unknown) {
        console.error('PDF++ reading progress:', error);
        if (this.status) this.status.textContent = 'PDF 进度保存失败';
        new Notice('PDF++ 进度读写失败，请检查同步目录权限。');
    }
    setStatus(text: string) { if (this.status) this.status.textContent = text; }
    async resumeActive(manual = false) {
        const leaf = this.plugin.app.workspace.activeLeaf;
        if (!leaf || !this.plugin.lib.isPDFView(leaf.view)) {
            if (manual) new Notice('请先打开一个 PDF 标签页。');
            return;
        }
        const component = leaf.view.viewer;
        const session = this.sessions.get(component);
        if (session) await session.resume(manual);
        else if (leaf.view.file) await this.open(component, leaf.view.file);
    }
    beforeOpen(component: PDFViewerComponent) {
        // The old viewer may change pages while the new file loads. Detach before loading it.
        this.generation.set(component, {});
        this.sessions.get(component)?.dispose();
        this.sessions.delete(component);
        this.restored.delete(component);
    }
    async open(component: PDFViewerComponent, file: TFile, subpath?: string, preserve = false) {
        this.sessions.get(component)?.dispose();
        this.sessions.delete(component);
        this.restored.delete(component);
        const token = {};
        this.generation.set(component, token);
        if (!this.plugin.settings.readingProgressSync) return;
        let progress: Progress | undefined;
        try { await this.store.flush(); progress = await this.store.newest(file.path); } catch (e) { this.report(e); }
        if (this.generation.get(component) !== token) return;
        const explicit = !!subpath && subpath !== '#';
        // File-modification reloads retain the current page, including immediately after adding text.
        if (progress && !explicit && !preserve) this.restored.set(component, progress);
        component.then(child => {
            let attempts = 0;
            const attach = () => {
                if (this.generation.get(component) !== token || child.unloaded) return;
                const viewer = child.pdfViewer.pdfViewer;
                if (!viewer) {
                    if (++attempts < 100) {
                        const id = window.setTimeout(attach, 50);
                        component.register(() => window.clearTimeout(id));
                    }
                    return;
                }
                const session = new ReadingSession(this, component, viewer, file.path, this.device, explicit || preserve, progress);
                this.sessions.set(component, session);
                component.register(() => {
                    session.dispose();
                    if (this.sessions.get(component) === session) this.sessions.delete(component);
                });
                session.start();
            };
            attach();
        });
    }
}

/** Capture a snapshot on navigation, never re-read a stale background viewer during disposal. */
export class ReadingSession {
    private disposed = false;
    private inputAt = 0;
    private revision = 0;
    private knownRevision = 0;
    private savedSignature = '';
    private pending: Progress | null = null;
    private timer: number | undefined;
    private captureTimer: number | undefined;
    private restoring = false;
    private ready = false;
    private interactionGeneration = 0;
    private listeners: (() => void)[] = [];
    constructor(private owner: ReadingProgressSync, private component: PDFViewerComponent, private viewer: PDFViewer,
        private path: string, private device: string, private explicit: boolean, private progress?: Progress) {
        this.revision = progress?.revision ?? 0;
        this.knownRevision = this.revision;
    }
    matchesRecord(path: string) { return path.startsWith(`${ROOT}/${hashPath(this.path)}/`); }
    async observeRemote() {
        if (this.disposed) return;
        try {
            const progress = await this.owner.store.newest(this.path);
            if (!progress || this.disposed) return;
            this.knownRevision = Math.max(this.knownRevision, progress.revision);
            if (this.active() && progress.device !== this.device && progress.revision > this.revision) {
                this.owner.setStatus(`PDF 有新进度：第 ${progress.page} 页 · 点击恢复`);
            }
        } catch (error) { console.error('PDF++ reading progress refresh:', error); }
    }
    active() {
        const leaf = this.owner.plugin.app.workspace.activeLeaf;
        return !!leaf && this.owner.plugin.lib.isPDFView(leaf.view) && leaf.view.viewer === this.component
            && !this.viewer.container.ownerDocument.hidden;
    }
    private state(): PDFViewExtraState {
        const location = this.viewer._location;
        return { page: location?.pageNumber ?? this.viewer.currentPageNumber,
            left: location?.left, top: location?.top, zoom: this.viewer.currentScale };
    }
    start() {
        const ready = () => {
            if (this.disposed) return;
            this.ready = true;
            if (!this.explicit && !this.inputAt && this.progress) this.apply(this.progress);
            else this.savedSignature = signature(this.state());
        };
        const input = () => {
            if (!this.active()) return;
            this.interactionGeneration++;
            this.explicit = false;
            this.inputAt = Date.now();
            // Toolbar paging/zoom controls live outside viewer.container.
            window.clearTimeout(this.captureTimer);
            this.captureTimer = window.setTimeout(() => this.capture(), 0);
        };
        const target = this.component.containerEl;
        for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown', 'input', 'click']) {
            target.addEventListener(type, input, { passive: true, capture: true });
            this.listeners.push(() => target.removeEventListener(type, input, true));
        }
        const capture = () => this.capture();
        this.viewer.eventBus.on('updateviewarea', capture);
        this.viewer.eventBus.on('pagechanging', capture);
        this.viewer.eventBus.on('pagesloaded', ready);
        this.listeners.push(() => {
            this.viewer.eventBus.off('updateviewarea', capture);
            this.viewer.eventBus.off('pagechanging', capture);
            this.viewer.eventBus.off('pagesloaded', ready);
        });
        const doc = this.viewer.container.ownerDocument;
        const visibility = () => {
            if (doc.hidden) this.deactivate();
            else if (this.active()) void this.resume(false);
        };
        doc.addEventListener('visibilitychange', visibility);
        this.listeners.push(() => doc.removeEventListener('visibilitychange', visibility));
        if (this.viewer.pagesCount) ready();
    }
    private capture() {
        if (this.disposed || !this.ready || this.restoring || !this.active() || !this.inputAt
            || Date.now() - this.inputAt > 30000 || !this.owner.plugin.settings.readingProgressSync) return;
        const state = this.state();
        if (!Number.isInteger(state.page) || state.page < 1) return;
        if (signature(state) === this.savedSignature) return;
        this.revision = Math.max(Date.now(), this.revision + 1, this.knownRevision + 1);
        this.pending = { ...state, schema: 1, file: this.path, device: this.device, revision: this.revision };
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => { void this.flush(); }, 500);
    }
    async flush() {
        window.clearTimeout(this.timer);
        const record = this.pending;
        if (!this.owner.plugin.settings.readingProgressSync) { this.pending = null; return; }
        if (!record) return;
        this.pending = null;
        try {
            await this.owner.store.write(record);
            this.savedSignature = signature(record);
            this.owner.setStatus(`PDF 第 ${record.page} 页 · 已保存到同步目录`);
        } catch (error) {
            if (!this.pending) this.pending = record;
            this.owner.report(error);
        }
    }
    private apply(progress: Progress) {
        if (!this.owner.plugin.settings.readingProgressSync || !this.viewer.pagesCount || progress.page > this.viewer.pagesCount) return;
        this.restoring = true;
        this.owner.plugin.lib.applyPDFViewStateToViewer(this.viewer, progress);
        this.revision = Math.max(this.revision, progress.revision);
        this.knownRevision = Math.max(this.knownRevision, progress.revision);
        this.progress = progress;
        this.savedSignature = signature(progress);
        this.inputAt = 0;
        this.restoring = false;
        this.owner.setStatus(`PDF 第 ${progress.page} 页 · 已恢复`);
    }
    async resume(manual: boolean) {
        if (this.disposed || !this.owner.plugin.settings.readingProgressSync) return;
        await this.flush();
        const generation = this.interactionGeneration;
        try {
            const progress = await this.owner.store.newest(this.path);
            // Do not jump if the user interacted while the disk read was in flight.
            if (this.disposed || generation !== this.interactionGeneration || this.pending) return;
            if (progress && (manual || (!this.explicit && progress.revision > this.revision))) {
                this.apply(progress);
                if (manual) new Notice(`已恢复到第 ${progress.page} 页（仅限已下载的同步记录）。`);
            } else if (manual) new Notice(progress ? '当前已是最近记录。' : '尚未找到该 PDF 的阅读进度。');
        } catch (error) { this.owner.report(error); }
    }
    deactivate() { this.inputAt = 0; void this.flush(); }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        window.clearTimeout(this.timer);
        window.clearTimeout(this.captureTimer);
        for (const remove of this.listeners) remove();
        void this.flush();
    }
}

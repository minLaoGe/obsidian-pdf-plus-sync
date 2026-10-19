import { source } from 'virtual:pdf-text-worker';
import type { BatchInput, BatchOutput } from './worker-engine';
import type { TextBox } from './pdf';
export interface PdfTextRunner {
    process(input: BatchInput): Promise<BatchOutput>;
    index(bytes: ArrayBuffer): Promise<TextBox[]>;
    verify(bytes: ArrayBuffer, digest: string): Promise<boolean>;
    destroy?(): void;
}
export class PdfTextWorker implements PdfTextRunner {
    private worker: Worker | null = null;
    private url: string | null = null;
    private sequence = 0;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>();
    private request(kind: string, payload: Record<string, unknown>, bytes: ArrayBuffer): Promise<any> {
        if (!this.worker) {
            this.url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            try { this.worker = new Worker(this.url); }
            catch (error) { URL.revokeObjectURL(this.url); this.url = null; throw error; }
            this.worker.onmessage = ({ data }) => {
                const request = this.waiting.get(data.id);
                if (!request) return;
                window.clearTimeout(request.timer); this.waiting.delete(data.id);
                if (data.error) request.reject(new Error(data.error)); else request.resolve(data.value);
            };
            this.worker.onerror = () => this.destroy();
        }
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => { this.waiting.delete(id); reject(new Error('PDF 后台处理超时，草稿已保留，请重试')); }, 120000);
            this.waiting.set(id, { resolve, reject, timer });
            try { this.worker!.postMessage({ id, kind, ...payload }, [bytes]); }
            catch (error) { window.clearTimeout(timer); this.waiting.delete(id); reject(error); }
        });
    }
    process(input: BatchInput): Promise<BatchOutput> { return this.request('process', { input }, input.bytes); }
    index(bytes: ArrayBuffer): Promise<TextBox[]> { return this.request('index', { bytes }, bytes); }
    verify(bytes: ArrayBuffer, digest: string): Promise<boolean> { return this.request('verify', { bytes, digest }, bytes); }
    destroy() {
        this.worker?.terminate(); this.worker = null;
        if (this.url) URL.revokeObjectURL(this.url); this.url = null;
        for (const request of this.waiting.values()) { window.clearTimeout(request.timer); request.reject(new Error('PDF 后台处理已停止，草稿仍在本机')); }
        this.waiting.clear();
    }
}

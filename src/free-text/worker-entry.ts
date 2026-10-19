import { digest, indexNotes, processBatch } from './worker-engine';
const scope = globalThis as unknown as { onmessage: (e: MessageEvent) => void; postMessage: (data: unknown, transfer?: Transferable[]) => void };
scope.onmessage = async ({ data }) => {
    try {
        let value: unknown;
        if (data.kind === 'index') value = await indexNotes(data.bytes);
        else if (data.kind === 'verify') value = digest(data.bytes) === data.digest;
        else value = await processBatch(data.input);
        const transfer = data.kind === 'process' ? [(value as Awaited<ReturnType<typeof processBatch>>).bytes.buffer as ArrayBuffer] : [];
        scope.postMessage({ id: data.id, value }, transfer);
    } catch (error) { scope.postMessage({ id: data.id, error: String(error.message ?? error) }); }
};

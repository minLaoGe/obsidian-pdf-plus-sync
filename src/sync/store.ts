import { TFile } from 'obsidian';
import type { Vault } from 'obsidian';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { PDFViewExtraState } from 'typings';

export const DATA_ROOT = 'PDF++ Sync';
export const ROOT = `${DATA_ROOT}/reading-progress`;
export const LEGACY_ROOT = 'PDF++ Reading Progress';
export interface Progress extends PDFViewExtraState {
    schema: 1;
    file: string;
    device: string;
    revision: number;
}
export function hashPath(path: string): string { return bytesToHex(sha256(utf8ToBytes(path))); }
export function validProgress(value: unknown): value is Progress {
    if (!value || typeof value !== 'object') return false;
    const p = value as Progress;
    return p.schema === 1 && typeof p.file === 'string' && p.file.length > 0
        && typeof p.device === 'string' && /^[\w-]{1,80}$/.test(p.device)
        && Number.isSafeInteger(p.page) && p.page > 0 && Number.isSafeInteger(p.revision) && p.revision > 0
        && [p.left, p.top, p.zoom].every(v => v === undefined || (typeof v === 'number' && Number.isFinite(v)))
        && (p.zoom === undefined || p.zoom > 0);
}
export function latest(records: Progress[]): Progress | undefined {
    return records.slice().sort((a, b) => b.revision - a.revision || b.device.localeCompare(a.device))[0];
}
export async function ensureFolder(vault: Vault, folder: string): Promise<void> {
    const parts = folder.split('/');
    for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/');
        if (!(await vault.adapter.exists(path))) {
            try { await vault.createFolder(path); }
            catch (error) { if (!(await vault.adapter.exists(path))) throw error; }
        }
    }
}

/** Read actual adapter files: incoming JSON may not have entered Obsidian's file cache yet. */
export class ProgressStore {
    private queue: Promise<unknown> = Promise.resolve();
    constructor(private vault: Vault) {}
    private async files(root: string): Promise<string[]> {
        if (!(await this.vault.adapter.exists(root))) return [];
        return (await this.vault.adapter.list(root)).files.filter(p => p.endsWith('.json'));
    }
    async read(path: string): Promise<Progress[]> {
        const paths = [...await this.files(`${ROOT}/${hashPath(path)}`), ...await this.files(LEGACY_ROOT)];
        const data = await Promise.all(paths.map(async p => {
            try {
                const value: unknown = JSON.parse(await this.vault.adapter.read(p));
                return validProgress(value) && value.file === path ? value : null;
            } catch { return null; }
        }));
        return data.filter((r): r is Progress => r !== null);
    }
    async newest(path: string): Promise<Progress | undefined> { return latest(await this.read(path)); }
    write(record: Progress): Promise<void> {
        if (!validProgress(record)) return Promise.reject(new Error('Invalid reading progress'));
        const run = this.queue.catch(() => {}).then(async () => {
            const folder = `${ROOT}/${hashPath(record.file)}`;
            await ensureFolder(this.vault, folder);
            const target = `${folder}/${record.device}.json`;
            if (await this.vault.adapter.exists(target)) {
                try {
                    const existing: unknown = JSON.parse(await this.vault.adapter.read(target));
                    if (validProgress(existing) && existing.file === record.file && existing.revision >= record.revision) return;
                } catch { /* Replace a corrupt record owned by this device. */ }
            }
            const text = JSON.stringify(record, null, 2) + '\n';
            const file = this.vault.getAbstractFileByPath(target);
            if (file instanceof TFile) await this.vault.modify(file, text);
            else if (await this.vault.adapter.exists(target)) await this.vault.adapter.write(target, text);
            else await this.vault.create(target, text);
        });
        this.queue = run;
        return run;
    }
    async migrateLegacy(): Promise<void> {
        for (const path of await this.files(LEGACY_ROOT)) {
            let data: unknown;
            try { data = JSON.parse(await this.vault.adapter.read(path)); } catch { continue; }
            if (validProgress(data)) await this.write(data);
        }
        // Leave old records intact so other devices can upgrade safely.
    }
    async flush(): Promise<void> { await this.queue; }
}

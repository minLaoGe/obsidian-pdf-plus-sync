import type { TextBox } from './pdf';
import { wrapText } from './pdf';

function paint(box: TextBox, canvas: HTMLCanvasElement | OffscreenCanvas): number {
    const width = box.rect[2] - box.rect[0];
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('当前设备不支持文字绘制');
    const font = `${box.fontSize}px -apple-system, BlinkMacSystemFont, "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.font = font;
    const lines = wrapText(box.text, Math.max(8, width - 8), s => ctx.measureText(s).width);
    const height = Math.max(box.fontSize * 1.4 + 8, lines.length * box.fontSize * 1.4 + 8);
    const scale = Math.min(3, 4096 / width, 4096 / height);
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    ctx.scale(scale, scale);
    ctx.font = font;
    ctx.fillStyle = box.color;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, 4, 4 + i * box.fontSize * 1.4));
    return height;
}
export function renderText(box: TextBox, doc: Document): { png: Uint8Array; height: number } {
    const canvas = doc.createElement('canvas');
    const height = paint(box, canvas);
    const raw = atob(canvas.toDataURL('image/png').split(',')[1]);
    return { png: Uint8Array.from(raw, c => c.charCodeAt(0)), height };
}
export async function renderOffscreen(box: TextBox): Promise<{ png: Uint8Array; height: number }> {
    const canvas = new OffscreenCanvas(1, 1);
    const height = paint(box, canvas);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { png: new Uint8Array(await blob.arrayBuffer()), height };
}

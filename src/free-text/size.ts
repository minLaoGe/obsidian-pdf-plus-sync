/** Width and height are stored in PDF points so the preference survives zoom changes. */
export function textBoxSize(value: unknown): { width: number; height: number } {
    const size = value as { width?: unknown; height?: unknown } | null;
    const width = typeof size?.width === 'number' && Number.isFinite(size.width) && size.width >= 10 && size.width <= 2000 ? size.width : 160;
    const height = typeof size?.height === 'number' && Number.isFinite(size.height) && size.height >= 10 && size.height <= 3000 ? size.height : 32;
    return { width, height };
}

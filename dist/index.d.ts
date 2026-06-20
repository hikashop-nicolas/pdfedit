export interface PdfEditorOptions {
    workerSrc?: string;
    scale?: number;
    onChange?: () => void;
}
export interface PdfEditor {
    getBytes(): Promise<Uint8Array>;
    isDirty(): boolean;
    destroy(): void;
}
export declare function createPdfEditor(container: HTMLElement, bytes: Uint8Array, options?: PdfEditorOptions): PdfEditor;

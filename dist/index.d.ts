export interface PdfEditorOptions {
    /** URL of the pdf.js worker (the consumer's bundler resolves this). */
    workerSrc?: string;
    /** Render scale (device px per PDF pt). Default 1.3. */
    scale?: number;
    /** Called whenever the document is edited. */
    onChange?: () => void;
}
export interface PdfEditor {
    /** Export the edited PDF as bytes (original bytes if nothing changed). */
    getBytes(): Promise<Uint8Array>;
    /** Whether anything has been edited. */
    isDirty(): boolean;
    destroy(): void;
}
export declare function createPdfEditor(container: HTMLElement, bytes: Uint8Array, options?: PdfEditorOptions): PdfEditor;

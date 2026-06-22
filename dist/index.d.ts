export interface PdfEditorOptions {
    workerSrc?: string;
    scale?: number;
    onChange?: () => void;
    /** Restore a prior editing session (from getState). Applied after the pages render. */
    initialState?: PdfEditState;
}
export interface PdfEditor {
    getBytes(): Promise<Uint8Array>;
    isDirty(): boolean;
    /** A serialisable snapshot of the editing session: the pristine bytes plus the edits made
     *  on top. Restoring re-renders the original and replays the edits (lossless, unlike
     *  re-opening an exported PDF), which is what a version-history tool should snapshot. */
    getState(): PdfEditState;
    destroy(): void;
}
/** One edited existing paragraph: its index among the rendered (non-added) paragraphs. */
export interface PdfParagraphEdit {
    page: number;
    index: number;
    html: string;
}
/** A text box the user added in blank space. */
export interface PdfBoxState {
    page: number;
    xPdf: number;
    yPdf: number;
    wPdf: number;
    size: number;
    align: "left" | "center" | "right" | "justify";
    family: "sans" | "serif" | "mono";
    colorHex: string;
    html: string;
}
/** An inserted image, with its viewport-space placement (render scale is constant per doc). */
export interface PdfImageState {
    page: number;
    bytes: Uint8Array;
    mime: string;
    leftPx: number;
    topPx: number;
    widthPx: number;
}
export interface PdfEditState {
    /** The pristine bytes the document was opened with (re-render base). */
    original: Uint8Array;
    edits: PdfParagraphEdit[];
    boxes: PdfBoxState[];
    images: PdfImageState[];
}
export declare function createPdfEditor(container: HTMLElement, bytes: Uint8Array, options?: PdfEditorOptions): PdfEditor;

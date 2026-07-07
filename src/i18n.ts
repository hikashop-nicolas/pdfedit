// Self-contained i18n for pdfedit so the library is a complete multilingual product on
// its own (it does not rely on its host for strings). Detects the locale from the
// browser / device preferred-languages list, base language first match, English fallback.
//
// Adding a language = add a dict to LOCALES. Hosts may force one via setLocale().

type Dict = Record<string, string>;

const en: Dict = {
  toolbar: "PDF editor tools",
  undo: "Undo (Ctrl+Z)",
  redo: "Redo (Ctrl+Y)",
  bold: "Bold",
  italic: "Italic",
  textColor: "Text color",
  font: "Font",
  fontFamily: "Font family",
  fontSize: "Font size (pt)",
  fontSizeAria: "Font size in points",
  alignLeft: "Align left",
  alignCenter: "Align center",
  alignRight: "Align right",
  justify: "Justify",
  link: "Link",
  linkTitle: "Add/edit link",
  linkAria: "Add or edit link",
  linkPrompt: "Link URL (empty to remove):",
  image: "Image",
  insertImage: "Insert image",
  zoom: "Zoom",
  zoomLevelAria: "Zoom level (percent)",
  zoomPctTitle: "Zoom (%)",
  zoomPctAria: "Zoom percent",
  imageBoxAria: "Inserted image. Arrow keys move it, plus and minus resize, Delete removes.",
  dragResize: "Drag to resize",
  deleteImage: "Delete image",
  droppedChars: "{n} character(s) could not be drawn with the available fonts and were left out of the saved PDF.",
  renderFailed: "This PDF could not be displayed. It may be corrupted or password-protected. Saving returns the file unchanged.",
};

const fr: Dict = {
  toolbar: "Outils d'édition PDF",
  undo: "Annuler (Ctrl+Z)",
  redo: "Rétablir (Ctrl+Y)",
  bold: "Gras",
  italic: "Italique",
  textColor: "Couleur du texte",
  font: "Police",
  fontFamily: "Famille de police",
  fontSize: "Taille de police (pt)",
  fontSizeAria: "Taille de police en points",
  alignLeft: "Aligner à gauche",
  alignCenter: "Centrer",
  alignRight: "Aligner à droite",
  justify: "Justifier",
  link: "Lien",
  linkTitle: "Ajouter/modifier un lien",
  linkAria: "Ajouter ou modifier un lien",
  linkPrompt: "URL du lien (vide pour retirer) :",
  image: "Image",
  insertImage: "Insérer une image",
  zoom: "Zoom",
  zoomLevelAria: "Niveau de zoom (pour cent)",
  zoomPctTitle: "Zoom (%)",
  zoomPctAria: "Zoom en pour cent",
  imageBoxAria: "Image insérée. Les flèches la déplacent, plus et moins la redimensionnent, Suppr la retire.",
  dragResize: "Glisser pour redimensionner",
  deleteImage: "Supprimer l'image",
  droppedChars: "{n} caractère(s) n'ont pas pu être dessinés avec les polices disponibles et ont été omis du PDF enregistré.",
  renderFailed: "Ce PDF n'a pas pu être affiché. Il est peut-être corrompu ou protégé par mot de passe. L'enregistrement renvoie le fichier inchangé.",
};

const ja: Dict = {
  toolbar: "PDF 編集ツール",
  undo: "元に戻す (Ctrl+Z)",
  redo: "やり直し (Ctrl+Y)",
  bold: "太字",
  italic: "斜体",
  textColor: "文字の色",
  font: "フォント",
  fontFamily: "フォントの種類",
  fontSize: "フォントサイズ (pt)",
  fontSizeAria: "フォントサイズ（ポイント）",
  alignLeft: "左揃え",
  alignCenter: "中央揃え",
  alignRight: "右揃え",
  justify: "両端揃え",
  link: "リンク",
  linkTitle: "リンクの追加/編集",
  linkAria: "リンクの追加または編集",
  linkPrompt: "リンク URL（空欄で削除）：",
  image: "画像",
  insertImage: "画像の挿入",
  zoom: "ズーム",
  zoomLevelAria: "ズームレベル（パーセント）",
  zoomPctTitle: "ズーム (%)",
  zoomPctAria: "ズーム（パーセント）",
  imageBoxAria: "挿入された画像。矢印キーで移動、プラスとマイナスでサイズ変更、Delete で削除します。",
  dragResize: "ドラッグしてサイズ変更",
  deleteImage: "画像を削除",
  droppedChars: "{n} 文字は利用可能なフォントで描画できず、保存された PDF から除外されました。",
  renderFailed: "この PDF は表示できませんでした。破損しているか、パスワードで保護されている可能性があります。保存してもファイルは変更されません。",
};

const LOCALES: Record<string, Dict> = { en, fr, ja };

let active: Dict | null = null;

function detect(): Dict {
  const prefs = (typeof navigator !== "undefined" && navigator.languages) || ["en"];
  for (const tag of prefs) {
    const base = tag.toLowerCase().split("-")[0]!;
    if (LOCALES[base]) return LOCALES[base]!;
  }
  return en;
}

/** Force a locale (host escape hatch). Unknown codes fall back to English. */
export function setLocale(code: string): void {
  active = LOCALES[code.toLowerCase().split("-")[0]!] ?? en;
}

export function t(key: string, params?: Record<string, string | number>): string {
  if (!active) active = detect();
  let s = active[key] ?? en[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
  return s;
}

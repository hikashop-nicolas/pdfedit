// Self-contained i18n for pdfedit so the library is a complete multilingual product on
// its own (it does not rely on its host for strings). Detects the locale from the
// browser / device preferred-languages list, base language first match, English fallback.
//
// Adding a language = add a dict to LOCALES. Hosts may force one via setLocale().

type Dict = Record<string, string>;

const en: Dict = {
  toolbar: "PDF editor tools",
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
};

const fr: Dict = {
  toolbar: "Outils d'édition PDF",
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
};

const LOCALES: Record<string, Dict> = { en, fr };

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

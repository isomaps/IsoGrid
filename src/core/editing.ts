/**
 * Édition de cellule.
 *
 * Une cellule en édition remplace son contenu par un champ de saisie, le temps
 * que l'utilisateur valide (Entrée, Tab, ou clic ailleurs) ou renonce (Échap).
 * La grille ne décide jamais seule qu'une valeur est acquise : elle la propose
 * à l'hôte via `onCellValueChanged`, et n'écrit dans la ligne que si l'hôte
 * l'accepte.
 *
 * Ce contrat asynchrone est ce qui rend l'édition utilisable sur un modèle
 * serveur : l'hôte a le temps d'appeler son API, et un rejet remet la cellule
 * dans son état d'avant sans que la grille ait à connaître la raison de
 * l'échec.
 *
 * Les éditeurs fournis ici couvrent les types de colonnes de la grille. Une
 * colonne qui a besoin d'autre chose — un sélecteur d'entité, un champ masqué,
 * une saisie assistée — fournit son propre `cellEditor` : la grille se
 * contente alors de le monter, de lui demander sa valeur, et de le démonter.
 */

import type { AnyRow, CellContext, ColumnDef } from './types'

/** Un éditeur monté dans une cellule. */
export interface CellEditor {
  /** L'élément inséré dans la cellule. */
  element: HTMLElement
  /** Prend le focus, et présélectionne le contenu quand c'est pertinent. */
  focus(): void
  /** La valeur saisie, dans la forme que l'éditeur produit. */
  getValue(): unknown
  /** Libère ce qui doit l'être (écouteurs externes, minuteurs). */
  destroy?(): void
}

export type CellEditorFactory<TRow = AnyRow> = (ctx: CellContext<TRow>) => CellEditor

/** Ce que reçoit l'hôte quand une cellule est validée. */
export interface CellEditEvent<TRow = AnyRow> {
  row: TRow
  /** Identifiant de ligne tel que `getRowId` le produit. */
  rowId: string
  rowIndex: number
  column: ColumnDef<TRow>
  oldValue: unknown
  newValue: unknown
}

export interface EditingOptions {
  /**
   * Geste qui ouvre l'édition.
   * `'none'` réserve l'ouverture à l'API — utile quand l'hôte a sa propre
   * logique (un bouton « modifier », un mode saisie global).
   */
  startOn?: 'dblclick' | 'click' | 'none'
  /**
   * Après validation par Entrée, passer à la même colonne de la ligne suivante.
   * C'est le geste attendu d'une saisie en colonne.
   */
  enterMovesDown?: boolean
}

/**
 * Valeur à donner à l'éditeur au montage.
 *
 * Les champs `date` et `datetime-local` n'acceptent qu'un format ISO tronqué ;
 * tout le reste passe par la chaîne brute.
 */
function valeurInitiale(type: ColumnDef['type'], valeur: unknown): string {
  if (valeur === null || valeur === undefined) return ''
  if (type === 'date' || type === 'datetime') {
    const d = valeur instanceof Date ? valeur : new Date(String(valeur))
    if (Number.isNaN(d.getTime())) return String(valeur)
    const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString()
    return type === 'date' ? iso.slice(0, 10) : iso.slice(0, 16)
  }
  return String(valeur)
}

/**
 * Convertit ce que l'éditeur a produit en valeur métier.
 *
 * Une chaîne vide devient `null` et non `0` ou `''` : sur un ERP, « effacé »
 * et « zéro » ne veulent pas dire la même chose, et c'est `null` que les API
 * attendent pour un champ vidé.
 */
export function parseEditedValue<TRow>(
  def: ColumnDef<TRow>,
  brut: unknown,
  ctx: CellContext<TRow>,
): unknown {
  if (def.valueParser) return def.valueParser(brut, ctx)
  if (typeof brut === 'boolean') return brut
  const texte = brut === null || brut === undefined ? '' : String(brut)
  if (texte === '') return null

  if (def.type === 'number') {
    /* La virgule décimale est la norme dans la moitié des locales servies. */
    const n = Number(texte.replace(',', '.'))
    return Number.isNaN(n) ? texte : n
  }
  return texte
}

/** Éditeur retenu quand la colonne n'en fournit pas. */
export function createDefaultEditor<TRow>(ctx: CellContext<TRow>): CellEditor {
  const def = ctx.column
  const type = def.type ?? 'text'

  if (type === 'boolean') {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'isg-cell-editor isg-cell-editor-check'
    input.checked = ctx.value === true || ctx.value === 1 || ctx.value === '1'
    return {
      element: input,
      focus: () => input.focus(),
      getValue: () => input.checked,
    }
  }

  /* Un jeu de valeurs connu se saisit mieux dans une liste que dans un champ
     libre ; on réutilise les options déjà déclarées pour le filtre ensembliste. */
  const options = typeof def.filter === 'object' && def.filter !== null
    ? (def.filter as { values?: { value: string, label?: string }[] }).values
    : undefined
  if (type === 'set' && options?.length) {
    const select = document.createElement('select')
    select.className = 'isg-cell-editor'
    const vide = document.createElement('option')
    vide.value = ''
    vide.textContent = ''
    select.append(vide)
    for (const o of options) {
      const opt = document.createElement('option')
      opt.value = o.value
      opt.textContent = o.label ?? o.value
      select.append(opt)
    }
    select.value = ctx.value === null || ctx.value === undefined ? '' : String(ctx.value)
    return {
      element: select,
      focus: () => select.focus(),
      getValue: () => select.value,
    }
  }

  const input = document.createElement('input')
  input.className = 'isg-cell-editor'
  input.type = type === 'number' ? 'number'
    : type === 'date' ? 'date'
    : type === 'datetime' ? 'datetime-local'
    : 'text'
  if (type === 'number') input.step = 'any'
  input.value = valeurInitiale(type, ctx.value)
  return {
    element: input,
    focus: () => { input.focus(); input.select?.() },
    getValue: () => input.value,
  }
}

/** La colonne accepte-t-elle l'édition pour cette cellule ? */
export function isCellEditable<TRow>(def: ColumnDef<TRow>, ctx: CellContext<TRow>): boolean {
  if (!def.editable) return false
  return typeof def.editable === 'function' ? def.editable(ctx) : true
}

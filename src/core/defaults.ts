/**
 * Valeurs par défaut partagées.
 *
 * Elles vivaient dans `grid.ts`, mais le rendu d'en-tête portait sa propre
 * copie de `headerHeight` : changer l'une sans l'autre laissait la grille
 * dans un état incohérent. Une seule source, importée là où c'est nécessaire.
 */
export const DEFAULTS = {
  rowHeight: 36,
  headerHeight: 48,
  blockSize: 100,
  maxBlocksInCache: 20,
  defaultColumnWidth: 160,
  selectionColumnWidth: 44,
  groupColumnWidth: 240,
  detailColumnWidth: 40,
  detailProvisionalHeight: 120,
  rowActionsWidth: 48,
  /** Lignes rendues en surplus au-dessus et au-dessous de la fenêtre visible. */
  overscan: 6,
} as const

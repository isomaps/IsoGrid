/**
 * Déclaration d'ambiance pour ExcelJS.
 *
 * ExcelJS est une `peerDependency` OPTIONNELLE : la lib doit compiler et se
 * bundler sans qu'il soit installé. On ne peut pas pour autant masquer le
 * spécificateur derrière une variable — un `import(specifier)` non analysable
 * statiquement n'est réécrit ni par Vite ni par les autres bundlers, et le
 * navigateur reçoit un identifiant nu qu'il ne sait pas résoudre.
 *
 * Cette déclaration garde donc `import('exceljs')` littéral (donc résolvable
 * par l'hôte) tout en satisfaisant TypeScript. Le typage est volontairement
 * lâche : la surface réellement utilisée est vérifiée dans `export/excel.ts`.
 */
declare module 'exceljs' {
  const ExcelJS: any
  export default ExcelJS
  export const Workbook: any
}

/**
 * Point d'entrée du bundle ExcelJS « vendorable ».
 *
 * On cible explicitement `exceljs/dist/exceljs.min.js` : c'est la version
 * navigateur du paquet. L'entrée principale d'ExcelJS vise Node et tire des
 * dépendances (`stream`, `fs`, `buffer`) qui n'ont rien à faire ici.
 */
// @ts-expect-error — build navigateur d'ExcelJS, sans déclaration de types
import ExcelJS from 'exceljs/dist/exceljs.min.js'

export default ExcelJS

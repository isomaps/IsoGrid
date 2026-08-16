/**
 * IsoGrid — point d'entrée public.
 *
 * @example
 * ```ts
 * import { IsoGrid } from '@isomaps/isogrid'
 * import '@isomaps/isogrid/style.css'
 *
 * const grid = new IsoGrid(document.querySelector('#grid')!, {
 *   rowModel: 'server',
 *   datasource: '/admin/factures/grid',
 *   columns: [
 *     { id: 'number', header: 'N°', pinned: 'start', width: 120 },
 *     { id: 'client', header: 'Client', filter: 'text' },
 *     { id: 'total',  header: 'Total', type: 'number', align: 'right' },
 *   ],
 * })
 * ```
 */

export { IsoGrid } from './ui/grid'
export { builtinIconRenderer, fontAwesomeIconRenderer } from './ui/icons'
export { ContextMenu, writeToClipboard } from './ui/context-menu'
export { SELECTION_COLUMN_ID, SelectionModel } from './core/selection'
export { GROUP_COLUMN_ID, GroupingModel } from './core/grouping'
export type { ContextMenuContext, ContextMenuItem, ContextMenuOptions } from './ui/context-menu'

export {
  autoRegisterIsoGridAlpine, isoGridAlpineComponent, registerIsoGridAlpine,
} from './adapters/alpine'
export type { AlpineLike, IsoGridAlpineConfig } from './adapters/alpine'
export { createLivewireDatasource } from './adapters/livewire'
export type { LivewireDatasourceOptions, WireProxy } from './adapters/livewire'

export { ClientDatasource } from './datasource/client'
export { BlockCache, createHttpDatasource } from './datasource/server'
export type { HttpDatasourceOptions } from './datasource/server'

export { SUPPORTED_LOCALES, Translator, catalogs, resolveLocale } from './core/i18n'
export type { MessageKey } from './core/i18n'

export {
  BINARY_OPERATORS, DEFAULT_OPERATOR, NULLARY_OPERATORS, OPERATORS,
  applyFilters, applySort, evaluateFilter, normalizeFilter, resolveFilterConfig,
} from './filters/model'

export type {
  HeaderCheckboxState, SelectionMode, SelectionSnapshot, SelectionState,
} from './core/selection'

export type {
  Align, AnyRow, BooleanOperator, CellContext, ColumnDef, ColumnFilterConfig,
  ColumnFilterModel, ColumnType, DataRequest, DataResponse, Datasource,
  DateOperator, ExportOptions, ExportProgress, FilterCondition, FilterOperator,
  FilterType, GridState, IconName, IsoGridApi, IsoGridOptions, LocaleCode,
  NumberOperator, PinPosition, SetFilterOption, SetOperator, SidebarOptions,
  SortModel, TextOperator, ThemeMode, ToolbarOptions,
} from './core/types'

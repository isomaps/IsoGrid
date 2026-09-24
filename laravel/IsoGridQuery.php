<?php

declare(strict_types=1);

namespace IsoMaps\IsoGrid;

use Illuminate\Contracts\Database\Query\Builder as BuilderContract;
use Illuminate\Database\Eloquent\Builder as EloquentBuilder;
use Illuminate\Contracts\Database\Query\Expression;
use Illuminate\Database\Query\Builder as QueryBuilder;
use Illuminate\Http\Request;
use InvalidArgumentException;

/**
 * Traduit une requête IsoGrid (tri, filtres, pagination, recherche globale)
 * en contraintes sur un Builder Eloquent ou Query.
 *
 * C'est la moitié serveur du contrat `Datasource` : sans elle, le mode
 * `rowModel: 'server'` n'a personne en face.
 *
 * Deux garde-fous portent tout le poids sécurité :
 *
 *  1. **Liste blanche de colonnes obligatoire.** Les identifiants de colonne
 *     arrivent du navigateur ; les injecter dans un `orderBy`/`where` sans
 *     les valider serait une injection SQL directe, car un nom de colonne ne
 *     peut pas être passé en paramètre lié.
 *  2. **Opérateurs fermés.** L'opérateur transmis n'est jamais concaténé : il
 *     sert de clé dans une table de correspondance.
 *
 * Exemple d'utilisation dans un contrôleur :
 *
 *     public function grid(Request $request)
 *     {
 *         return IsoGridQuery::make($request)
 *             ->allow([
 *                 'number'   => 'invoices.number',
 *                 'client'   => 'clients.name',
 *                 'total'    => 'invoices.total',
 *                 'date'     => 'invoices.issued_at',
 *                 'status'   => 'invoices.status',
 *             ])
 *             ->searchable(['number', 'client'])
 *             ->respond(
 *                 Invoice::query()->join('clients', 'clients.id', '=', 'invoices.client_id'),
 *                 fn (Invoice $invoice) => [
 *                     'number' => $invoice->number,
 *                     'client' => $invoice->client->name,
 *                     'total'  => (float) $invoice->total,
 *                     'date'   => $invoice->issued_at?->toDateString(),
 *                     'status' => $invoice->status,
 *                 ],
 *             );
 *     }
 */
final class IsoGridQuery
{
    /** Correspondance id de colonne exposé => expression SQL réelle. */
    private array $allowed = [];

    /** Colonnes balayées par la recherche globale. */
    private array $searchable = [];

    /** Plafond de lignes servies en une requête, garde-fou contre un `endRow` délirant. */
    private int $maxPageSize = 5000;

    /**
     * Découpage en sections, déclaré côté serveur.
     *
     * @var null|array{column: string, direction: string, totals: array<int, string>, label: string|null}
     */
    private ?array $sections = null;

    /**
     * Totaux du pied, déclarés côté serveur.
     *
     * @var array<string, array{agg: string, par: string|null}>
     */
    private array $footer = [];

    private function __construct(private readonly array $payload) {}

    /**
     * Construit depuis une charge utile déjà décodée — c'est la voie utilisée
     * par Livewire, dont les méthodes reçoivent directement un tableau.
     *
     * @param  array<string, mixed>  $payload
     */
    public static function fromArray(array $payload): self
    {
        return new self($payload);
    }

    public static function make(Request $request): self
    {
        // Le client poste du JSON ; le mode GET encode le même objet dans `q`.
        $payload = $request->isMethod('GET') && $request->filled('q')
            ? json_decode((string) $request->query('q'), true, 32, JSON_THROW_ON_ERROR)
            : $request->all();

        return new self(is_array($payload) ? $payload : []);
    }

    /**
     * Déclare les colonnes autorisées.
     *
     * La valeur peut être un nom de colonne (`'users.name'`) ou une
     * `Expression` (`DB::raw('(select …)')`) — indispensable pour rendre
     * triable et filtrable une donnée calculée : agrégat, concaténation d'une
     * relation, CASE. Laravel n'échappe pas une `Expression`, donc elle doit
     * être écrite ICI, jamais construite à partir d'une entrée utilisateur.
     *
     * @param  array<string, string|Expression>|array<int, string>  $columns
     */
    public function allow(array $columns): self
    {
        foreach ($columns as $key => $value) {
            $this->allowed[is_int($key) ? $value : $key] = $value;
        }

        return $this;
    }

    /** @param  array<int, string>  $columns  identifiants exposés */
    public function searchable(array $columns): self
    {
        $this->searchable = $columns;

        return $this;
    }

    public function maxPageSize(int $size): self
    {
        $this->maxPageSize = max(1, $size);

        return $this;
    }

    /**
     * Totaux du pied de grille, calculés sur TOUT le jeu filtré.
     *
     *     ->footer(['montant' => 'sum'])
     *     ->footer(['montant' => ['sum', 'par' => 'devise']])  // un total par devise
     *
     * `par` regroupe le total selon une autre colonne : une colonne de montants
     * qui mêle francs et euros ne s'additionne pas — le résultat serait un
     * nombre qui n'existe pas.
     *
     * @param  array<string, string|array<int|string, string>>  $spec
     */
    public function footer(array $spec): self
    {
        foreach ($spec as $colonne => $regle) {
            $agg = is_array($regle) ? (string) ($regle[0] ?? 'sum') : (string) $regle;
            $par = is_array($regle) ? ($regle['par'] ?? null) : null;
            if (in_array($agg, ['sum', 'avg', 'min', 'max', 'count'], true)) {
                $this->footer[(string) $colonne] = ['agg' => $agg, 'par' => $par !== null ? (string) $par : null];
            }
        }

        return $this;
    }

    /**
     * Découpe le résultat en sections sur une colonne donnée.
     *
     * L'identifiant vient du CODE et non de la requête : un découpage est une
     * décision de page, pas une option que le navigateur négocie. Il doit
     * malgré tout figurer dans `allow()`, comme toute colonne touchee par du SQL.
     *
     * @param  array<int|string, string|array<int|string, string>>  $totals
     *   colonnes à sommer : `['montant']`, ou `['montant' => ['sum', 'par' => 'devise']]`
     *   pour un total PAR DEVISE — une colonne qui mêle francs et euros ne
     *   s'additionne pas.
     * @param  string|null  $labelColumn  colonne portant l'intitulé lisible
     */
    /**
     * @param  array<int|string, string|array<int|string, string>>  $totals
     * @return array<int, array{id: string, par: string|null}>
     */
    private static function normaliserTotaux(array $totals): array
    {
        $liste = [];
        foreach ($totals as $cle => $regle) {
            if (is_int($cle)) {
                $liste[] = ['id' => (string) $regle, 'par' => null];

                continue;
            }
            $liste[] = [
                'id' => (string) $cle,
                'par' => is_array($regle) && isset($regle['par']) ? (string) $regle['par'] : null,
            ];
        }

        return $liste;
    }

    public function sections(
        string $columnId,
        string $direction = 'desc',
        array $totals = [],
        ?string $labelColumn = null,
    ): self {
        $this->sections = [
            'column' => $columnId,
            'direction' => strtolower($direction) === 'asc' ? 'asc' : 'desc',
            'totals' => self::normaliserTotaux($totals),
            // L'intitulé vient du SERVEUR et non du navigateur : « Décembre
            // 2026 » dépend de la langue, et MySQL ne nomme les mois en
            // français que si `lc_time_names` est réglé — ce qu'on ne peut pas
            // supposer. Le libellé est donc une colonne comme une autre, que
            // la page compose comme elle l'entend.
            'label' => $labelColumn,
        ];

        return $this;
    }

    /* ------------------------------------------------------------------ */
    /* Lecture de la requête                                               */
    /* ------------------------------------------------------------------ */

    public function startRow(): int
    {
        return max(0, (int) ($this->payload['startRow'] ?? 0));
    }

    public function endRow(): int
    {
        return max($this->startRow(), (int) ($this->payload['endRow'] ?? 100));
    }

    public function limit(): int
    {
        return min($this->maxPageSize, $this->endRow() - $this->startRow());
    }

    /** Traduit un identifiant exposé en colonne ou expression, ou null s'il n'est pas autorisé. */
    private function resolve(string $columnId): string|Expression|null
    {
        return $this->allowed[$columnId] ?? null;
    }

    /** Rend une colonne autorisée sous forme de SQL utilisable en GROUP BY. */
    private function expressionSql(string|Expression $column): string
    {
        return $column instanceof Expression
            ? $column->getValue(\Illuminate\Support\Facades\DB::connection()->getQueryGrammar())
            : $column;
    }

    /* ------------------------------------------------------------------ */
    /* Application au Builder                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Applique filtres et recherche globale, SANS tri ni pagination — c'est
     * cette forme qu'il faut compter pour obtenir `rowCount`.
     *
     * @template T of EloquentBuilder|QueryBuilder
     * @param  T  $query
     * @return T
     */
    public function applyFilters(EloquentBuilder|QueryBuilder $query): EloquentBuilder|QueryBuilder
    {
        foreach ((array) ($this->payload['filters'] ?? []) as $columnId => $model) {
            $column = $this->resolve((string) $columnId);
            if ($column === null || ! is_array($model)) {
                continue;
            }

            $conditions = array_values(array_filter(
                (array) ($model['conditions'] ?? []),
                is_array(...),
            ));
            if ($conditions === []) {
                continue;
            }

            $type = (string) ($model['type'] ?? 'text');
            $joinWithOr = ($model['join'] ?? 'and') === 'or';

            // Chaque filtre de colonne est un groupe parenthésé : sans ça, un
            // `or` interne s'échapperait et neutraliserait les autres filtres.
            $query->where(function (BuilderContract $group) use ($conditions, $column, $type, $joinWithOr): void {
                foreach ($conditions as $index => $condition) {
                    $boolean = ($index > 0 && $joinWithOr) ? 'or' : 'and';
                    $this->applyCondition($group, $column, $type, $condition, $boolean);
                }
            });
        }

        $search = trim((string) ($this->payload['quickFilter'] ?? ''));
        if ($search !== '' && $this->searchable !== []) {
            $query->where(function (BuilderContract $group) use ($search): void {
                foreach ($this->searchable as $columnId) {
                    $column = $this->resolve($columnId);
                    if ($column !== null) {
                        $group->orWhere($column, 'like', '%'.self::escapeLike($search).'%');
                    }
                }
            });
        }

        return $query;
    }

    /**
     * Applique le tri. Les identifiants non autorisés sont ignorés
     * silencieusement plutôt que de faire échouer la requête : une colonne
     * retirée du back-office ne doit pas casser une grille dont l'état
     * persisté la mentionne encore.
     *
     * @template T of EloquentBuilder|QueryBuilder
     * @param  T  $query
     * @return T
     */
    public function applySort(EloquentBuilder|QueryBuilder $query): EloquentBuilder|QueryBuilder
    {
        foreach ((array) ($this->payload['sort'] ?? []) as $sort) {
            if (! is_array($sort)) {
                continue;
            }
            $column = $this->resolve((string) ($sort['id'] ?? ''));
            if ($column === null) {
                continue;
            }
            $query->orderBy($column, ($sort['desc'] ?? false) ? 'desc' : 'asc');
        }

        return $query;
    }

    /**
     * @template T of EloquentBuilder|QueryBuilder
     * @param  T  $query
     * @return T
     */
    public function applyPagination(EloquentBuilder|QueryBuilder $query): EloquentBuilder|QueryBuilder
    {
        return $query->offset($this->startRow())->limit($this->limit());
    }

    /**
     * Ordonne par la colonne de section AVANT le tri demandé.
     *
     * Sans cela, les sections seraient fausses dès le premier tri : la grille
     * pose les intertitres sur des effectifs consécutifs (« les 34 premières
     * lignes sont de décembre »), ce qui n'a de sens que si les lignes du même
     * mois se suivent. Le tri de l'utilisateur garde tout son effet — il
     * réordonne À L'INTÉRIEUR de chaque section.
     *
     * @template T of EloquentBuilder|QueryBuilder
     * @param  T  $query
     * @return T
     */
    public function applySectionOrder(EloquentBuilder|QueryBuilder $query): EloquentBuilder|QueryBuilder
    {
        if ($this->sections === null) {
            return $query;
        }
        $column = $this->resolve($this->sections['column']);
        if ($column === null) {
            throw new InvalidArgumentException(
                "IsoGrid: colonne de section « {$this->sections['column']} » non autorisée"
            );
        }

        return $query->orderBy($column, $this->sections['direction']);
    }

    private function applyCondition(
        BuilderContract $query,
        string|Expression $column,
        string $type,
        array $condition,
        string $boolean,
    ): void {
        $operator = (string) ($condition['op'] ?? '');
        $value = $condition['value'] ?? null;
        $value2 = $condition['value2'] ?? null;

        // Vide / non vide : traiter la chaîne vide comme du vide, sinon un
        // champ texte « non renseigné » remonte comme renseigné.
        if ($operator === 'blank') {
            $query->where(function (BuilderContract $q) use ($column): void {
                $q->whereNull($column)->orWhere($column, '=', '');
            }, boolean: $boolean);

            return;
        }
        if ($operator === 'notBlank') {
            $query->where(function (BuilderContract $q) use ($column): void {
                $q->whereNotNull($column)->where($column, '!=', '');
            }, boolean: $boolean);

            return;
        }

        if ($type === 'set') {
            $values = array_values((array) $value);
            if ($values === []) {
                return;
            }
            $operator === 'notIn'
                ? $query->whereNotIn($column, $values, $boolean)
                : $query->whereIn($column, $values, $boolean);

            return;
        }

        if ($type === 'boolean') {
            $query->where($column, '=', filter_var($value, FILTER_VALIDATE_BOOLEAN), $boolean);

            return;
        }

        if ($type === 'text') {
            $escaped = self::escapeLike((string) $value);
            $pattern = match ($operator) {
                'contains', 'notContains' => '%'.$escaped.'%',
                'startsWith' => $escaped.'%',
                'endsWith' => '%'.$escaped,
                default => null,
            };

            if ($pattern !== null) {
                $sqlOperator = $operator === 'notContains' ? 'not like' : 'like';
                $query->where($column, $sqlOperator, $pattern, $boolean);

                return;
            }

            $query->where($column, $operator === 'notEquals' ? '!=' : '=', (string) $value, $boolean);

            return;
        }

        // number / date : opérateurs de comparaison, jamais concaténés.
        if ($operator === 'between') {
            $bounds = [self::cast($type, $value), self::cast($type, $value2)];
            sort($bounds);
            $query->whereBetween($column, $bounds, $boolean);

            return;
        }

        $sqlOperator = match ($operator) {
            'equals' => '=',
            'notEquals' => '!=',
            'gt', 'after' => '>',
            'gte' => '>=',
            'lt', 'before' => '<',
            'lte' => '<=',
            default => throw new InvalidArgumentException("IsoGrid: opérateur inconnu « {$operator} »"),
        };

        $query->where($column, $sqlOperator, self::cast($type, $value), $boolean);
    }

    private static function cast(string $type, mixed $value): mixed
    {
        if ($type === 'number') {
            return is_numeric($value) ? $value + 0 : 0;
        }

        return $value;
    }

    /** Neutralise les jokers LIKE pour qu'un `%` saisi reste un caractère littéral. */
    private static function escapeLike(string $value): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $value);
    }

    /* ------------------------------------------------------------------ */
    /* Réponse                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Exécute la requête et rend la réponse attendue par IsoGrid.
     *
     * Le comptage se fait sur la requête filtrée mais NON triée : compter une
     * requête ordonnée fait travailler la base pour rien.
     *
     * @param  callable(mixed): array<string, mixed>|null  $transform
     * @return array{rows: array<int, mixed>, rowCount: int}
     */
    public function respond(
        EloquentBuilder|QueryBuilder $query,
        ?callable $transform = null,
    ): array {
        $filtered = $this->applyFilters(clone $query);
        $rowCount = (clone $filtered)->count();

        // Totaux avec le PREMIER bloc seulement : les blocs suivants, charges
        // au defilement, portent sur le meme jeu filtre — les recalculer a
        // chaque page ajouterait une requete d'agregat par bloc pour rien. Un
        // bloc sans `footer` laisse la grille garder le dernier recu.
        $footer = $this->footer !== [] && $this->startRow() === 0 ? $this->footerValues($filtered) : null;

        $rows = $this->applyPagination(
            $this->applySort($this->applySectionOrder($filtered))
        )->get();
        if ($transform !== null) {
            $rows = $rows->map($transform);
        }

        $reponse = ['rows' => $rows->values()->all(), 'rowCount' => $rowCount];
        if ($footer !== null) {
            $reponse['footer'] = $footer;
        }

        return $reponse;
    }

    /**
     * Valeurs du pied, sur la requête déjà filtrée.
     *
     * @return array<string, float|array<string, float>|null>
     */
    private function footerValues(EloquentBuilder|QueryBuilder $filtered): array
    {
        $valeurs = [];

        foreach ($this->footer as $id => $regle) {
            $colonne = $this->resolve($id);
            if ($colonne === null) {
                continue;
            }
            $expr = $this->expressionSql($colonne);
            $agg = $regle['agg'];

            $base = clone $filtered;
            // Même piège que les sections : repartir d'un SELECT vide, sans
            // tri — sinon ONLY_FULL_GROUP_BY refuse le GROUP BY.
            $sous = $base instanceof EloquentBuilder ? $base->getQuery() : $base;
            $sous->columns = null;
            $sous->orders = null;

            $par = $regle['par'] !== null ? $this->resolve($regle['par']) : null;

            if ($par === null) {
                $v = $base->selectRaw("{$agg}({$expr}) as v")->value('v');
                $valeurs[$id] = $v === null ? null : (float) $v;

                continue;
            }

            $parSql = $this->expressionSql($par);
            $valeurs[$id] = $base
                ->selectRaw("{$parSql} as cle")
                ->selectRaw("{$agg}({$expr}) as v")
                ->groupByRaw($parSql)
                ->orderByRaw($parSql)
                ->get()
                ->filter(fn ($r) => $r->cle !== null && $r->cle !== '')
                ->mapWithKeys(fn ($r) => [(string) $r->cle => (float) $r->v])
                ->all();
        }

        return $valeurs;
    }

    /**
     * Effectifs et totaux par section, sur le jeu FILTRÉ ENTIER.
     *
     * C'est la seule façon d'avoir des intertitres justes en défilement par
     * blocs : une section chevauche souvent deux blocs, et un total calculé
     * sur les seules lignes chargées serait faux sans que rien ne le dise.
     *
     * @return array<int, array{value: mixed, count: int, totals: array<string, float>}>
     */
    public function sectionCounts(EloquentBuilder|QueryBuilder $query): array
    {
        if ($this->sections === null) {
            return [];
        }
        $column = $this->resolve($this->sections['column']);
        if ($column === null) {
            throw new InvalidArgumentException(
                "IsoGrid: colonne de section « {$this->sections['column']} » non autorisée"
            );
        }
        $expression = $this->expressionSql($column);

        $base = $this->applyFilters(clone $query);

        // ⚠️ Même piège que `setValues()` : la requête d'origine sélectionne
        // ses colonnes calculées, et un GROUP BY par-dessus fait échouer MySQL
        // en ONLY_FULL_GROUP_BY — sections vides, sans message à l'écran.
        $sousJacente = $base instanceof EloquentBuilder ? $base->getQuery() : $base;
        $sousJacente->columns = null;
        $sousJacente->orders = null;

        // Copie VIERGE (filtrée, sans colonnes ni tri) pour les totaux par devise,
        // qui demandent leur propre GROUP BY (section, devise).
        $vierge = clone $base;

        $base->selectRaw($expression.' as section_value')->selectRaw('count(*) as section_count');

        $libelle = $this->sections['label'] !== null ? $this->resolve($this->sections['label']) : null;
        if ($libelle !== null) {
            $base->selectRaw($this->expressionSql($libelle).' as section_label');
        }

        $totaux = [];
        $parDevise = [];
        foreach ($this->sections['totals'] as ['id' => $id, 'par' => $par]) {
            $colonne = $this->resolve($id);
            if ($colonne === null) {
                continue;
            }

            // Total PAR DEVISE : une requête groupée par (section, devise), fusionnée
            // ensuite dans chaque section sous la forme { CHF: …, EUR: … }.
            $parColonne = $par !== null ? $this->resolve($par) : null;
            if ($parColonne !== null) {
                $parSql = $this->expressionSql($parColonne);
                $lignes = (clone $vierge)
                    ->selectRaw($expression.' as sv')
                    ->selectRaw($parSql.' as cle')
                    ->selectRaw('sum('.$this->expressionSql($colonne).') as v')
                    ->groupByRaw($expression)
                    ->groupByRaw($parSql)
                    ->orderByRaw($parSql)
                    ->get();
                foreach ($lignes as $l) {
                    if ($l->cle === null || $l->cle === '') {
                        continue;
                    }
                    $parDevise[(string) $l->sv][$id][(string) $l->cle] = (float) $l->v;
                }

                continue;
            }

            // L'alias est indexé et non construit sur l'identifiant : un nom
            // de colonne exposé peut contenir de quoi casser l'alias.
            $alias = 'section_total_'.count($totaux);
            $totaux[$alias] = $id;
            $base->selectRaw('sum('.$this->expressionSql($colonne).') as '.$alias);
        }

        if ($libelle !== null) {
            // Le libellé entre dans le GROUP BY : en ONLY_FULL_GROUP_BY, une
            // colonne sélectionnée mais non groupée fait échouer la requête.
            $base->groupByRaw($this->expressionSql($libelle));
        }

        return $base
            ->groupByRaw($expression)
            ->orderByRaw($expression.' '.$this->sections['direction'])
            ->get()
            ->map(function ($row) use ($totaux, $parDevise): array {
                $sommes = [];
                foreach ($totaux as $alias => $id) {
                    $sommes[$id] = (float) ($row->{$alias} ?? 0);
                }
                foreach ($parDevise[(string) $row->section_value] ?? [] as $id => $carte) {
                    $sommes[$id] = $carte;
                }

                $section = [
                    'value' => $row->section_value,
                    'count' => (int) $row->section_count,
                    'totals' => $sommes,
                ];
                if (isset($row->section_label)) {
                    $section['label'] = (string) $row->section_label;
                }

                return $section;
            })
            ->all();
    }

    /**
     * Valeurs distinctes d'une colonne, pour un filtre `set`.
     *
     * Le filtre de la colonne interrogée est volontairement retiré : sinon
     * cocher une valeur ferait disparaître toutes les autres de la liste.
     *
     * @return array<int, array{value: mixed, count: int}>
     */
    public function setValues(EloquentBuilder|QueryBuilder $query, string $columnId): array
    {
        $column = $this->resolve($columnId);
        if ($column === null) {
            throw new InvalidArgumentException("IsoGrid: colonne « {$columnId} » non autorisée");
        }

        $withoutSelf = new self([
            'filters' => array_diff_key((array) ($this->payload['filters'] ?? []), [$columnId => null]),
            'quickFilter' => $this->payload['quickFilter'] ?? '',
        ]);
        $withoutSelf->allowed = $this->allowed;
        $withoutSelf->searchable = $this->searchable;

        $expression = $this->expressionSql($column);

        $base = $withoutSelf->applyFilters(clone $query);

        // ⚠️ Repartir d'un SELECT VIDE. La requête d'origine sélectionne
        // souvent ses colonnes calculées (`select t.*, (…) as total`), et un
        // GROUP BY ajouté par-dessus fait échouer MySQL en mode
        // ONLY_FULL_GROUP_BY : « 'id' isn't in GROUP BY ». Le filtre `set`
        // renvoyait alors une liste vide, sans aucun message côté écran.
        $sousJacente = $base instanceof EloquentBuilder ? $base->getQuery() : $base;
        $sousJacente->columns = null;

        return $base
            ->selectRaw($expression.' as value')
            ->selectRaw('count(*) as count')
            ->groupByRaw($expression)
            ->orderByRaw($expression)
            ->get()
            ->map(fn ($row) => ['value' => $row->value, 'count' => (int) $row->count])
            ->all();
    }
}

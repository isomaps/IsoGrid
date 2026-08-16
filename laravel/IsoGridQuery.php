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

        $rows = $this->applyPagination($this->applySort($filtered))->get();
        if ($transform !== null) {
            $rows = $rows->map($transform);
        }

        return ['rows' => $rows->values()->all(), 'rowCount' => $rowCount];
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

        $expression = $column instanceof Expression
            ? $column->getValue(\Illuminate\Support\Facades\DB::connection()->getQueryGrammar())
            : $column;

        return $withoutSelf->applyFilters(clone $query)
            ->selectRaw($expression.' as value')
            ->selectRaw('count(*) as count')
            ->groupByRaw($expression)
            ->orderByRaw($expression)
            ->get()
            ->map(fn ($row) => ['value' => $row->value, 'count' => (int) $row->count])
            ->all();
    }
}

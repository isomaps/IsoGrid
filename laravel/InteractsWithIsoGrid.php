<?php

declare(strict_types=1);

namespace IsoMaps\IsoGrid;

use Illuminate\Database\Eloquent\Builder as EloquentBuilder;
use Illuminate\Database\Query\Builder as QueryBuilder;

/**
 * Branche une grille IsoGrid sur un composant Livewire (ou une page Filament,
 * qui en est un).
 *
 * Intérêt par rapport à une route HTTP dédiée : le composant tourne déjà dans
 * le contexte authentifié — session, utilisateur, policies, panneau Filament,
 * tenant courant. Il n'y a donc ni route à déclarer, ni middleware à recopier,
 * ni jeton CSRF à gérer : Livewire s'en charge.
 *
 * ⚠️ Les méthodes publiques d'un composant Livewire sont appelables depuis le
 * navigateur avec une charge utile arbitraire. La liste blanche renvoyée par
 * `isoGridColumns()` est donc la seule barrière contre l'injection SQL, et
 * `isoGridQuery()` doit déjà porter les restrictions de périmètre (le
 * `->where('tenant_id', …)` ne se rajoute pas après coup).
 *
 * Exemple minimal :
 *
 *     class ListUsers extends Page
 *     {
 *         use InteractsWithIsoGrid;
 *
 *         protected function isoGridQuery(): EloquentBuilder
 *         {
 *             return User::query();
 *         }
 *
 *         protected function isoGridColumns(): array
 *         {
 *             return ['name' => 'users.name', 'email' => 'users.email'];
 *         }
 *
 *         protected function isoGridSearchable(): array
 *         {
 *             return ['name', 'email'];
 *         }
 *     }
 */
trait InteractsWithIsoGrid
{
    /** Requête de base. Toutes les restrictions de périmètre doivent y figurer. */
    abstract protected function isoGridQuery(): EloquentBuilder|QueryBuilder;

    /**
     * Liste blanche des colonnes exposées.
     *
     * @return array<string, string>  identifiant côté grille => expression SQL
     */
    abstract protected function isoGridColumns(): array;

    /** @return array<int, string> identifiants balayés par la recherche globale */
    protected function isoGridSearchable(): array
    {
        return [];
    }

    /**
     * Transforme un enregistrement en ligne JSON. Retourner `null` laisse le
     * modèle être sérialisé tel quel.
     *
     * @return null|callable(mixed): array<string, mixed>
     */
    protected function isoGridTransform(): ?callable
    {
        return null;
    }

    /** Plafond de lignes par requête. */
    protected function isoGridMaxPageSize(): int
    {
        return 500;
    }

    private function isoGridResolver(array $payload): IsoGridQuery
    {
        return IsoGridQuery::fromArray($payload)
            ->allow($this->isoGridColumns())
            ->searchable($this->isoGridSearchable())
            ->maxPageSize($this->isoGridMaxPageSize());
    }

    /**
     * Point d'entrée appelé par la grille pour obtenir un bloc de lignes.
     *
     * @param  array<string, mixed>  $request
     * @return array{rows: array<int, mixed>, rowCount: int}
     */
    public function isoGridRows(array $request): array
    {
        return $this->isoGridResolver($request)->respond(
            $this->isoGridQuery(),
            $this->isoGridTransform(),
        );
    }

    /**
     * Valeurs distinctes d'une colonne, pour un filtre `set`.
     *
     * @param  array<string, mixed>  $payload
     * @return array{values: array<int, array{value: mixed, count: int}>}
     */
    public function isoGridSetValues(array $payload): array
    {
        $column = (string) ($payload['column'] ?? '');

        $values = $this->isoGridResolver([
            'filters' => $payload['filters'] ?? [],
            'quickFilter' => $payload['quickFilter'] ?? '',
        ])->setValues($this->isoGridQuery(), $column);

        return ['values' => $values];
    }
}

/**
 * The one shape every schema-target reader and writer agrees on.
 *
 * `catalog.ts` reads a live database into this shape; `schema-target.ts` (and its
 * `schema-target/` parts) commit it as the frozen baseline; `scripts/schema-target-extract.ts`
 * compares the two.
 */

export interface ForeignKeyTarget {
  /** This table's referencing columns, in constraint key order. */
  columns: string[];
  /** The referenced table's own name (both sides always live in the `zz` schema). */
  refTable: string;
  /** The referenced table's columns, in the same order as `columns`. */
  refColumns: string[];
  /** `pg_constraint.confdeltype`, spelled out: NO ACTION, RESTRICT, CASCADE, SET NULL, SET DEFAULT. */
  onDelete: string;
  deferrable: boolean;
}

export interface TableTarget {
  /** `[name, type, nullable, default]` per column, in ordinal (`attnum`) order. `type` is
   *  `format_type`'s own rendering; `default` is `pg_get_expr` on the column's `pg_attrdef`,
   *  or `null` when the column has none. */
  columns: [name: string, type: string, nullable: boolean, defaultExpr: string | null][];
  primaryKey: string[] | null;
  /** One entry per UNIQUE constraint, each already in its own key order. Sorted by constraint
   *  name so the list itself is stable across runs. */
  uniques: string[][];
  /** Sorted by constraint name. */
  foreignKeys: ForeignKeyTarget[];
  /** `pg_get_constraintdef` on every CHECK constraint, sorted by constraint name. */
  checks: string[];
  /** `pg_get_indexdef` on every index that is not backing a constraint (a constraint's own
   *  index is already implied by `primaryKey`/`uniques`), sorted by index name. */
  indexes: string[];
  comment: string | null;
  /** Only the columns that carry a comment. */
  columnComments: Record<string, string>;
}

export interface SchemaTarget {
  phase: number;
  tables: Record<string, TableTarget>;
}

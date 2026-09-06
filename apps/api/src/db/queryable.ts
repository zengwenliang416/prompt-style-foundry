import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Minimal structural query interface satisfied by pg Client, Pool, and
 * PoolClient — repositories depend on this instead of a concrete driver type
 * (architecture §4: infrastructure depends on domain ports, not vice versa).
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

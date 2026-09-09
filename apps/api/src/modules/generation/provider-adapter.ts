export * from '@onepic/managed-runtime/provider-adapter';

// Historical API-path compatibility: this type was re-exported by the old
// implementation even though the provider adapter itself does not use SQL.
export type { Queryable } from '../../db/queryable.js';

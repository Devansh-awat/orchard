import { ScimError } from './scim-error';

// Advertised as filter.maxResults in ServiceProviderConfig, so it has to be
// the number we actually honour — clients page against totalResults.
export const SCIM_MAX_RESULTS = 200;

export interface ScimQuery {
  filter?: string;
  attributes?: string;
  excludedAttributes?: string;
  sortBy?: string;
  sortOrder?: string;
  startIndex?: number;
  count?: number;
}

// SCIMMY inspects query params with `"key" in params`, not by value, so an
// explicitly-undefined key reads as "supplied but not a string" and 400s with
// invalidFilter. Every request has to carry only the params the client actually
// sent — otherwise a bare GET /Users is rejected, and a filtered one only works
// if attributes and excludedAttributes tag along.
export function parseScimQuery(q: Record<string, any>): ScimQuery {
  const query: ScimQuery = {};
  if (q.filter !== undefined) query.filter = q.filter;
  if (q.attributes !== undefined) query.attributes = q.attributes;
  if (q.excludedAttributes !== undefined) query.excludedAttributes = q.excludedAttributes;
  if (q.sortBy !== undefined) query.sortBy = q.sortBy;
  if (q.sortOrder !== undefined) query.sortOrder = q.sortOrder;

  for (const key of ['startIndex', 'count'] as const) {
    if (q[key] === undefined) continue;
    const value = Number(q[key]);
    if (!Number.isInteger(value)) {
      throw ScimError(400, 'invalidValue', `Expected ${key} to be an integer`);
    }
    query[key] = value;
  }

  // RFC 7644 §3.4.2.4: a count above the provider's maximum is capped, not an
  // error, and an unbounded list is capped the same way.
  query.count = Math.min(query.count ?? SCIM_MAX_RESULTS, SCIM_MAX_RESULTS);
  return query;
}

// RFC 7644 §3.4.3: POST .../.search carries the same parameters as a GET query
// in a JSON body wrapped in the SearchRequest schema.
export function parseScimSearchBody(body: any): ScimQuery {
  if (Object(body) !== body || Array.isArray(body)) {
    throw ScimError(400, 'invalidSyntax', 'Expected search request body to be a single complex value');
  }
  return parseScimQuery(body);
}

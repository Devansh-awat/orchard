import SCIMMY from 'scimmy';

// SCIMMY types scimType as a plain string, but RFC 7644 §3.12 leaves it out
// entirely for codes like 404 and 501, hence the null-tolerant wrapper.
export function ScimError(status: number, scimType: string | null, detail: string) {
  return new SCIMMY.Types.Error(status, scimType as any, detail);
}

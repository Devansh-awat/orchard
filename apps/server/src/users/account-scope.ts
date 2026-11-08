export const ACCOUNT_SCOPE = 'account';

export function accountEmail(email: string) {
  return { emailScope_email: { emailScope: ACCOUNT_SCOPE, email } };
}

export function identityEmail(organizationId: string, email: string) {
  return { emailScope_email: { emailScope: organizationId, email } };
}

export function isOrgIdentity(user: { homeOrganizationId?: string | null } | null | undefined) {
  return Boolean(user?.homeOrganizationId);
}

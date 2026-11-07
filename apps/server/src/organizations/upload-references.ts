export type UploadReferenceModel =
  | 'user'
  | 'organization'
  | 'project'
  | 'identityProvider'
  | 'orgSsoSettings'
  | 'template';

export interface UploadOwner {
  model: UploadReferenceModel;
  id: string;
  column: string;
}

const REFERENCING_COLUMNS: { model: UploadReferenceModel; column: string; idField: string }[] = [
  { model: 'user', column: 'imageUrl', idField: 'id' },
  { model: 'organization', column: 'avatarUrl', idField: 'id' },
  { model: 'project', column: 'icon', idField: 'id' },
  { model: 'project', column: 'backgroundImage', idField: 'id' },
  { model: 'identityProvider', column: 'iconUrl', idField: 'id' },
  { model: 'orgSsoSettings', column: 'loginLogoUrl', idField: 'organizationId' },
  { model: 'template', column: 'icon', idField: 'id' }
];

type Counter = Record<string, { count(args: unknown): Promise<number> }>;

export async function uploadReferencedElsewhere(
  db: unknown,
  key: string,
  owner: UploadOwner
): Promise<boolean> {
  const tables = db as Counter;
  for (const target of REFERENCING_COLUMNS) {
    const where: Record<string, unknown> = { [target.column]: { contains: key } };
    if (target.model === owner.model && target.column === owner.column) {
      where.NOT = { [target.idField]: owner.id };
    }
    if ((await tables[target.model].count({ where })) > 0) return true;
  }
  return false;
}

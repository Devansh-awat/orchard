export type Row = Record<string, any>;

export type Tables = Record<string, Row[]>;

function matchValue(actual: any, expected: any): boolean {
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    if ('in' in expected) return expected.in.includes(actual);
    if ('not' in expected) return actual !== expected.not;
  }
  return actual === expected;
}

export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'organizationId_userId') {
      return row.organizationId === value.organizationId && row.userId === value.userId;
    }
    if (key === 'providerId_userId') {
      return row.providerId === value.providerId && row.userId === value.userId;
    }
    if (key === 'providerId_subject') {
      return row.providerId === value.providerId && row.subject === value.subject;
    }
    return matchValue(row[key], value);
  });
}

export function collection(
  tables: Tables,
  name: string,
  defaults: () => Row = () => ({}),
  hydrate: (row: Row | undefined) => Row | null = (row) => row ?? null
) {
  const rows = tables[name];
  return {
    findFirst: async ({ where }: any = {}) => hydrate(rows.find((r) => matches(r, where))),
    findUnique: async ({ where }: any) => hydrate(rows.find((r) => matches(r, where))),
    findMany: async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).map(hydrate),
    count: async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: any) => {
      const row = { ...defaults(), ...data };
      rows.push(row);
      return hydrate(row);
    },
    createMany: async ({ data }: any) => {
      for (const d of data) rows.push({ ...defaults(), ...d });
      return { count: data.length };
    },
    update: async ({ where, data }: any) => {
      const row = rows.find((r) => matches(r, where))!;
      Object.assign(row, data);
      return hydrate(row);
    },
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
    upsert: async ({ where, create, update }: any) => {
      const row = rows.find((r) => matches(r, where));
      if (row) {
        Object.assign(row, update);
        return hydrate(row);
      }
      const created = { ...defaults(), ...create };
      rows.push(created);
      return hydrate(created);
    },
    delete: async ({ where }: any) => {
      const i = rows.findIndex((r) => matches(r, where));
      return rows.splice(i, 1)[0];
    },
    deleteMany: async ({ where }: any) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], where)) {
          rows.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    }
  };
}

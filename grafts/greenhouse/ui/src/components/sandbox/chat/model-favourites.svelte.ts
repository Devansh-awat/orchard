import { ocDefaultFavourites, ocModelGroups, ocModelKey, type OcModel } from '../opencode';

export const FAVOURITES_STORAGE_KEY = 'greenhouse.models.favourites';
const ANON = 'anon';

type Stored = Record<string, string[]>;

function readAll(): Stored {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVOURITES_STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [user, keys] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(keys)) out[user] = keys.filter((k): k is string => typeof k === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

export class ModelFavourites {
  user = $state(ANON);
  #all = $state<Stored>(readAll());

  readonly keys = $derived<string[] | null>(this.#all[this.user] ?? null);

  use(userId: string | null | undefined) {
    const next = userId || ANON;
    if (next !== this.user) this.user = next;
  }

  resolve(models: OcModel[]): OcModel[] {
    const keys = this.keys;
    if (!keys) return ocDefaultFavourites(ocModelGroups(models));
    const byKey = new Map(models.map((m) => [ocModelKey(m), m]));
    return keys.map((k) => byKey.get(k)).filter((m): m is OcModel => !!m);
  }

  has(model: OcModel, models: OcModel[]): boolean {
    const key = ocModelKey(model);
    return this.resolve(models).some((m) => ocModelKey(m) === key);
  }

  toggle(model: OcModel, models: OcModel[]) {
    const key = ocModelKey(model);
    const visible = this.resolve(models).map(ocModelKey);
    const next = visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key];
    this.#write(next, visible);
  }

  move(from: number, to: number, models: OcModel[]) {
    const visible = this.resolve(models).map(ocModelKey);
    if (from === to || from < 0 || to < 0 || from >= visible.length || to >= visible.length) return;
    const next = [...visible];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this.#write(next, visible);
  }

  #write(next: string[], visible: string[]) {
    const hidden = (this.keys ?? []).filter((k) => !visible.includes(k) && !next.includes(k));
    this.#all = { ...this.#all, [this.user]: [...next, ...hidden] };
    try {
      localStorage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify(this.#all));
    } catch {
      return;
    }
  }
}

export const modelFavourites = new ModelFavourites();

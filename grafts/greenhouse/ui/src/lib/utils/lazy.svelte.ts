export class Lazy<T> {
  current = $state.raw<T | null>(null);
  #load: () => Promise<{ default: T }>;
  #pending: Promise<T | null> | null = null;

  constructor(load: () => Promise<{ default: T }>) {
    this.#load = load;
  }

  preload(): Promise<T | null> {
    this.#pending ??= this.#load()
      .then((module) => (this.current = module.default))
      .catch((error) => {
        this.#pending = null;
        console.error('Failed to load module', error);
        return null;
      });
    return this.#pending;
  }
}

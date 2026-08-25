import { browser } from "$app/environment";

export type ThemeChoice = "light" | "dark" | "system";
export type Resolved = "light" | "dark";

const KEY = "orchard-landing-theme";

function systemPref(): Resolved {
  if (!browser) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readChoice(): ThemeChoice {
  if (!browser) return "system";
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

class Theme {
  choice = $state<ThemeChoice>("system");
  system = $state<Resolved>("light");

  resolved = $derived<Resolved>(
    this.choice === "system" ? this.system : this.choice,
  );

  constructor() {
    if (!browser) return;
    this.choice = readChoice();
    this.system = systemPref();

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", (e) => {
      this.system = e.matches ? "dark" : "light";
    });

    $effect.root(() => {
      $effect(() => {
        document.documentElement.dataset.theme = this.resolved;
      });
    });
  }

  set(choice: ThemeChoice) {
    this.choice = choice;
    if (!browser) return;
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  }

  toggle() {
    this.set(this.resolved === "dark" ? "light" : "dark");
  }
}

export const theme = new Theme();

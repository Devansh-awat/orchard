<script lang="ts">
  import { Sun, Moon } from "lucide-svelte";
  import { theme } from "$lib/theme.svelte";
</script>

<button
  type="button"
  onclick={() => theme.toggle()}
  class="relative rounded-full p-2 text-ink-700 hover:bg-[var(--hairline)] hover:text-ink-900"
  aria-label={theme.resolved === "dark"
    ? "Switch to light mode"
    : "Switch to dark mode"}
>
  {#if theme.resolved === "dark"}
    <Sun size={18} strokeWidth={1.75} aria-hidden="true" />
  {:else}
    <Moon size={18} strokeWidth={1.75} aria-hidden="true" />
  {/if}
  <span
    class="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
    aria-hidden="true"
  ></span>
</button>

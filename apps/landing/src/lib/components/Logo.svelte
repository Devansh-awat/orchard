<script lang="ts">
  import { theme } from "$lib/theme.svelte";

  let { class: className = "h-8 w-auto" }: { class?: string } = $props();
</script>

<img
  src={theme.resolved === "dark" ? "/logo/logocolordm.svg" : "/logo/logocolor.svg"}
  alt="Orchard"
  width="132"
  height="32"
  class={className}
/>

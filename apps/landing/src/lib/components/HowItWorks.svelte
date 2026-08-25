<script lang="ts">
  import { reveal } from "$lib/motion.svelte";
  import Shot from "./Shot.svelte";

  const steps = [
    {
      n: "01",
      title: "Point it at a repo",
      body: "Pick a GitHub repo and a branch. Orchard reads the Dockerfile, finds the build stage and the port, and fills in the environment it can infer.",
    },
    {
      n: "02",
      title: "Watch it build",
      body: "The build runs on your cluster with logs streaming as they happen, so a failure tells you which line broke instead of just going red.",
    },
    {
      n: "03",
      title: "It is live",
      body: "You get an HTTPS URL, health checks, and replicas on a slider. Every push after that deploys itself, and any deploy rolls back.",
    },
  ];
</script>

<section id="how" class="section-y scroll-mt-16 bg-shell-50">
  <div class="section-x">
    <div>
      <h2
        {@attach reveal()}
        class="max-w-[24ch] text-4xl font-semibold tracking-tight text-balance text-ink-900 md:text-5xl"
      >
        From push to production.
      </h2>
      <p
        {@attach reveal({ index: 1 })}
        class="mt-5 max-w-[48ch] text-lg text-pretty text-ink-700"
      >
        Three steps, and only the first one needs you.
      </p>
    </div>

    <ol role="list" class="mt-14 grid gap-8 md:grid-cols-3 md:gap-6">
      {#each steps as step, i (step.n)}
        <li {@attach reveal({ index: i + 2 })} class="hairline-t pt-5">
          <p class="font-mono text-sm tracking-wide text-primary-600 tabular-nums">
            {step.n}
          </p>
          <h3 class="mt-3 text-xl font-semibold tracking-tight text-ink-900">
            {step.title}
          </h3>
          <p class="mt-2 text-pretty text-ink-700">{step.body}</p>
        </li>
      {/each}
    </ol>

    <div {@attach reveal({ index: 5, y: 20 })} class="mt-14">
      <Shot
        name="deployment"
        alt="A running Orchard app on three replicas, with live logs, CPU and memory, and a replica slider"
      />
    </div>
  </div>
</section>

<script lang="ts">
  import { reveal, hover } from "$lib/motion.svelte";
  import Shot from "./Shot.svelte";
</script>

<header class="relative overflow-hidden">
  <div
    class="pointer-events-none absolute -top-32 -right-40 h-[40rem] w-[40rem] bg-[radial-gradient(closest-side,var(--color-shell-100)_0%,transparent_100%)]"
    aria-hidden="true"
  ></div>
  <div
    class="section-x relative grid items-center gap-12 py-20 lg:grid-cols-12 lg:py-28"
  >
    <div class="lg:col-span-5">
      <p
        {@attach reveal({ index: 0 })}
        class="font-mono text-sm tracking-wide text-primary-600 uppercase"
      >
        Open source soon
      </p>
      <div>
        <h1
          {@attach reveal({ index: 1 })}
          class="mt-6 max-w-[16ch] text-5xl font-semibold tracking-tight text-balance text-ink-900 md:text-6xl"
        >
          Kubernetes, made easy.
        </h1>
        <p
          {@attach reveal({ index: 2 })}
          class="mt-6 max-w-[48ch] text-lg text-pretty text-ink-700"
        >
          Push a repo. Get a running app. On the cluster you already own.
        </p>
      </div>
      <div
        {@attach reveal({ index: 3 })}
        class="mt-9 flex flex-wrap items-center gap-3"
      >
        <a
          href="https://github.com/LeafdTK/leaf"
          {@attach hover()}
          class="btn btn-lg btn-primary"
        >
          Run it on your cluster
        </a>
        <a href="#how" class="btn btn-lg btn-outline">See how it works</a>
      </div>
      <p {@attach reveal({ index: 5 })} class="mt-7 text-ink-500">
        A <span class="font-medium text-ink-700">Hack Club</span> project created
        by
        <a
          href="https://github.com/LeafdTK"
          class="font-medium text-ink-900 underline decoration-primary-300 underline-offset-4 hover:decoration-primary-500"
        >
          Leafd
        </a>.
      </p>
    </div>
    <div class="lg:col-span-7">
      <div {@attach reveal({ index: 6, y: 24 })}>
        <Shot
          name="project"
          alt="An Orchard project page: a pixel-art gradient header over running apps and their databases"
          priority
          class="lg:w-[132%]"
        />
      </div>
    </div>
  </div>
</header>

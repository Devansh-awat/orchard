import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { docUrl, plainTitle, sortEntries } from "../lib/llms";

/** llms-full.txt: the whole documentation set as one markdown document. */
export const GET: APIRoute = async () => {
  const entries = sortEntries(await getCollection("docs"));

  const parts = [
    "# Orchard documentation",
    "",
    "Orchard is a self-hosted platform that installs into your own Kubernetes",
    "cluster and turns a GitHub repo into a running app.",
    "",
    "---",
    "",
  ];

  for (const entry of entries) {
    parts.push(`# ${plainTitle(entry)}`, "");
    if (entry.data.description) parts.push(`> ${entry.data.description}`, "");
    parts.push(`Source: ${docUrl(entry)}`, "");
    parts.push(entry.body?.trim() ?? "", "", "---", "");
  }

  return new Response(parts.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

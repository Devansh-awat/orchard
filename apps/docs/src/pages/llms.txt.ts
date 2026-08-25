import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { SITE, mdUrl, plainTitle, sortEntries } from "../lib/llms";

/**
 * llms.txt: a compact index of the documentation for agents that want to
 * decide what to read before reading it. Every entry links to the raw
 * markdown, not the rendered page.
 */
export const GET: APIRoute = async () => {
  const entries = sortEntries(await getCollection("docs"));

  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const section = entry.id.includes("/")
      ? entry.id.split("/")[0]
      : "Overview";
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push(entry);
  }

  const lines = [
    "# Orchard",
    "",
    "> Orchard is a self-hosted platform that installs into your own Kubernetes",
    "> cluster and turns a GitHub repo into a running app: builds, an HTTPS URL,",
    "> managed PostgreSQL, jobs, logs, rollbacks, teams and SSO.",
    "",
    "Every link below returns raw markdown. Append `.md` to any documentation URL",
    "to get its source. `/llms-full.txt` contains the entire documentation set.",
    "",
  ];

  for (const [section, items] of groups) {
    lines.push(`## ${section}`, "");
    for (const entry of items) {
      const description = entry.data.description
        ? `: ${entry.data.description}`
        : "";
      lines.push(`- [${plainTitle(entry)}](${mdUrl(entry)})${description}`);
    }
    lines.push("");
  }

  lines.push("## Reference", "");
  lines.push(
    `- [API reference](${SITE}/api/): every endpoint, generated from the OpenAPI contract`,
  );
  lines.push("");

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

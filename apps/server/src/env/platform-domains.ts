/**
 * Public hostnames Orchard hands out come from operator-supplied config only.
 * Nothing here invents a domain: an unset value means the feature is not
 * configured, and callers must degrade rather than substitute a default. A
 * self-hosted instance publishing URLs under a domain it doesn't own, whether
 * somebody else's or a plausible-looking guess under APP_DOMAIN, is worse
 * than one publishing none.
 *
 * The vanity domain is a case in point: it is neither the app domain nor the
 * platform host. On the Hack Club cluster the UI is served from
 * orchard.infra.hackclub.com, apps land on k.hackclub.dev, and org vanity
 * hosts sit under orchard.my: three different domains. Guessing any one from
 * another would be wrong.
 */
export function optionalDomain(value: string | undefined): string {
  return (value || '')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase();
}

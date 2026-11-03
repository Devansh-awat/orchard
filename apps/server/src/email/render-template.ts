/**
 * Filling `{{name}}` markers in the MJML email templates.
 *
 * The markers are data, not code, and a formatter that decides they are an
 * expression will pad them to `{{ name }}`. Matching them literally meant that
 * turned every affected marker into text the recipient reads: the sign-in mail
 * shipped `{{ otpCode }}` where the code should have been. So the pattern
 * tolerates the whitespace, and anything left unfilled is reported rather than
 * posted to someone: a marker that survives rendering is always a bug, and
 * silence is what let this one out.
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function fillTemplate(
  source: string,
  values: Record<string, string>
): { output: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const output = source.replace(PLACEHOLDER, (marker, name: string) => {
    const value = values[name];
    if (value === undefined) {
      if (!unresolved.includes(name)) unresolved.push(name);
      return marker;
    }
    return value;
  });
  return { output, unresolved };
}

export type ClaimableEntry = {
  kind: string;
  text?: string;
  messageID?: string;
  local?: boolean;
};

export type ClaimAuthor = { id: string } | null | undefined;

function isUser(entry: ClaimableEntry): boolean {
  return entry.kind === 'user';
}

function unclaimed(entry: ClaimableEntry): boolean {
  return isUser(entry) && !entry.messageID && !!entry.local;
}

function someoneElse(author: ClaimAuthor, selfId: string | null): boolean {
  return !!author && !!selfId && author.id !== selfId;
}

export function knownPrompt(entries: readonly ClaimableEntry[], messageId: string): boolean {
  return entries.some((entry) => isUser(entry) && entry.messageID === messageId);
}

export function claimForMessage(
  entries: readonly ClaimableEntry[],
  messageId: string,
  author: ClaimAuthor,
  selfId: string | null
): number | null {
  if (knownPrompt(entries, messageId) || someoneElse(author, selfId)) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!isUser(entries[i])) continue;
    return unclaimed(entries[i]) ? i : null;
  }
  return null;
}

export type PartPlacement = { claim: number } | { push: true } | null;

export function placeUserPart(
  entries: readonly ClaimableEntry[],
  part: { messageID: string; text: string },
  author: ClaimAuthor,
  selfId: string | null
): PartPlacement {
  if (knownPrompt(entries, part.messageID)) return null;
  if (someoneElse(author, selfId)) return { push: true };
  const text = part.text.trim();
  const match = entries.findIndex(
    (entry) => unclaimed(entry) && (entry.text ?? '').trim() === text
  );
  if (match >= 0) return { claim: match };
  if (entries.some(unclaimed)) return null;
  return { push: true };
}

export function claimOwnPrompt(
  entries: readonly ClaimableEntry[],
  messageId: string
): number | null {
  if (knownPrompt(entries, messageId)) return null;
  const index = entries.findIndex(unclaimed);
  return index >= 0 ? index : null;
}

export interface DiffSides {
  original: string;
  modified: string;
  isNew: boolean;
  isDeleted: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function sidesFromUnifiedDiff(diff: string): DiffSides {
  const before: string[] = [];
  const after: string[] = [];
  let oldAt = 0;
  let newAt = 0;
  let inHunk = false;
  let isNew = false;
  let isDeleted = false;
  for (const line of diff.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldAt = Math.max(1, Number(hunk[1]));
      newAt = Math.max(1, Number(hunk[2]));
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('new file')) isNew = true;
      if (line.startsWith('deleted file')) isDeleted = true;
      continue;
    }
    const mark = line[0];
    const text = line.slice(1);
    if (mark === ' ') {
      before[oldAt++] = text;
      after[newAt++] = text;
    } else if (mark === '-') {
      before[oldAt++] = text;
    } else if (mark === '+') {
      after[newAt++] = text;
    }
  }
  const join = (lines: string[]) => Array.from(lines.slice(1), (l) => l ?? '').join('\n');
  return { original: join(before), modified: join(after), isNew, isDeleted };
}

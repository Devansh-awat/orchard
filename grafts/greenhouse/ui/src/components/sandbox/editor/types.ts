import type { Component } from 'svelte';
import type { CommentAuthor, DiffComment, RemoteDraftComment } from './comments.svelte';

export type DiffLayout = 'split' | 'inline';

export interface EditorSelectionRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  text: string;
}

export interface DiffThreadProps {
  comments: DiffComment[];
  remote: RemoteDraftComment[];
  drafting: boolean;
  draftBody: string;
  author?: CommentAuthor;
  onsubmit: (body: string) => void;
  oncancel: () => void;
  onreply: () => void;
  onremove: (id: string) => void;
  ondraftinput: (body: string) => void;
}

export interface StripTab {
  id: string;
  title: string;
  icon?: Component;
  dirty?: boolean;
  closable?: boolean;
  tooltip?: string;
}

export { default as MonacoEditor } from './MonacoEditor.svelte';
export { default as MonacoDiff } from './MonacoDiff.svelte';
export type { DiffLayout, EditorSelectionRange, DiffThreadProps, StripTab } from './types';
export { default as EditorTabs } from './EditorTabs.svelte';
export { default as TabStrip } from './TabStrip.svelte';
export { default as DiffThread } from './DiffThread.svelte';
export {
	EditorWorkspace,
	EditorDocument,
	toDocumentUri,
	toFsPath,
	baseName,
	type EditorFs,
	type DocumentUri,
	type OpenOptions
} from './workspace.svelte';
export {
	DiffComments,
	type DiffComment,
	type DiffSide,
	type CommentAuthor,
	type RemoteDraftComment,
	type LocalDraft,
	type NewDiffComment,
	type PromptOptions
} from './comments.svelte';
export {
	RemoteCursorLayer,
	remoteColorVar,
	REMOTE_COLOR_VARS,
	type CollabBinding,
	type RemoteCursor,
	type RemoteSelection
} from './collab';
export {
	YjsRoom,
	frameRoom,
	applyTextDiff,
	type CollabStatus,
	type RoomPeer,
	type RoomEvent,
	type YFrame
} from './yjs-room';
export { TextBinding, type BindingModel } from './text-binding';
export { diffText, mergeText, type TextEdit } from './text-diff';
export { loadMonaco, monacoLoaded, type MonacoApi } from './load';
export { buildMonacoTheme, applyMonacoTheme, useMonacoTheme, MONACO_THEME } from './theme';
export { languageForPath, languageLabel } from './languages';

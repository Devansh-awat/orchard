import { QueryClient } from '@tanstack/svelte-query';

// Singleton client. Lives at module scope so any non-component code
// (subscribeOrgEvents, mutation helpers, etc.) can invalidate keys without
// having to be handed the QueryClient by a parent. The provider in
// +layout.svelte mounts THIS instance.
export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 30_000,
			gcTime: 5 * 60_000,
			refetchOnWindowFocus: false,
			retry: 1,
		},
	},
});

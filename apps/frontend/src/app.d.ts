// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	const __APP_VERSION__: string;
	const __UI_VERSION__: string;
	const __ORCHARD_MOCK__: boolean;

	namespace App {
		// interface Error {}
		interface Locals {
			subdomain?: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

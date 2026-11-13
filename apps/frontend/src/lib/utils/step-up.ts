export type StepUpCode =
	| 'current_password_required'
	| 'current_password_incorrect'
	| 'reauth_required';

export class StepUpError extends Error {
	constructor(
		message: string,
		readonly code: StepUpCode | null
	) {
		super(message);
	}

	get needsCurrentPassword(): boolean {
		return this.code === 'current_password_required' || this.code === 'current_password_incorrect';
	}

	get needsSignIn(): boolean {
		return this.code === 'reauth_required';
	}
}

export async function stepUpError(response: Response, fallback: string): Promise<StepUpError> {
	const data = await response.json().catch(() => ({}));
	return new StepUpError(data?.message || fallback, data?.code ?? null);
}

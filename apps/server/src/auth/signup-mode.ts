export type SignupMode = 'open' | 'invite_only' | 'closed';

export function signupMode(): SignupMode {
  const mode = process.env.SIGNUP_MODE;
  return mode === 'open' || mode === 'closed' ? mode : 'invite_only';
}

export function signupDeniedError(): string {
  return signupMode() === 'closed' ? 'signups_disabled' : 'private_beta';
}

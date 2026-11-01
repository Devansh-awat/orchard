const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parts(version: string): number[] | null {
	const match = SEMVER.exec(version.trim());
	return match ? match.slice(1).map(Number) : null;
}

export function noteReleased(note: string, running: string): boolean {
	const target = parts(note);
	if (!target) return false;
	const current = parts(running);
	if (!current) return true;
	for (let i = 0; i < 3; i++) {
		if (target[i] !== current[i]) return target[i] < current[i];
	}
	return true;
}

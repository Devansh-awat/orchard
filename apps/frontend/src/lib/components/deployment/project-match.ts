export function findProjectByName<T extends { name: string }>(
	projects: T[],
	name: string | null | undefined
): T | null {
	const wanted = name?.trim().toLowerCase();
	if (!wanted) return null;
	return projects.find((p) => p.name.trim().toLowerCase() === wanted) ?? null;
}

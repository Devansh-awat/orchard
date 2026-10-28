const CATEGORY: Record<string, string> = {
	automation: 'Automation',
	cms: 'Publishing',
	monitoring: 'Monitoring',
	analytics: 'Analytics',
	security: 'Security',
	ai: 'AI',
	docs: 'Docs',
	games: 'Games',
	database: 'Databases',
	backend: 'Backend',
	developer: 'Developer tools'
};

export function templateCategory(category?: string | null): string {
	if (!category) return 'Template';
	return CATEGORY[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

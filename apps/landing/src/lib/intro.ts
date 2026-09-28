export function introMode(): 'cascade' | null {
	return document.documentElement.dataset.intro === 'cascade' ? 'cascade' : null;
}

export function finishIntro() {
	delete document.documentElement.dataset.intro;
}

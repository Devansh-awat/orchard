const ignore = () => undefined;

export function settled(transition: ViewTransition): Promise<void> {
	transition.ready.catch(ignore);
	return transition.finished.catch(ignore);
}

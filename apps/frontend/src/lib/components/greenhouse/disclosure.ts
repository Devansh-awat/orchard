export const HOST_DISCLOSURE =
	'Guests can run your agent on your Claude subscription, read and change every file on this machine including credentials stored in it, use terminals, and see anything you type in shared terminals.';

export function guestDisclosure(host: string, readOnly: boolean): string {
	const base = `This machine belongs to ${host}. They can see everything you do here, including your terminal sessions.`;
	if (readOnly) return base;
	return `${base} When you push, your GitHub token is used for that command inside their machine.`;
}

function read(key: string): boolean {
	if (typeof localStorage === 'undefined') return false;
	try {
		return localStorage.getItem(key) === '1';
	} catch {
		return false;
	}
}

function write(key: string) {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key, '1');
	} catch {
		return;
	}
}

const shareKey = (machineId: string) => `greenhouse-share-ack:${machineId}`;
const joinKey = (userId: string, machineId: string) => `greenhouse-join-ack:${userId}:${machineId}`;

export function shareAcknowledged(machineId: string): boolean {
	return read(shareKey(machineId));
}

export function acknowledgeShare(machineId: string) {
	write(shareKey(machineId));
}

export function joinAcknowledged(userId: string, machineId: string): boolean {
	return read(joinKey(userId, machineId));
}

export function acknowledgeJoin(userId: string, machineId: string) {
	write(joinKey(userId, machineId));
}

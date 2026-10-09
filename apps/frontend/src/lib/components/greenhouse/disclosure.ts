export function guestDisclosure(host: string, readOnly: boolean): string {
	return readOnly
		? `${host}'s machine, read only.`
		: `${host}'s machine. They can see what you do here.`;
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

const joinKey = (userId: string, machineId: string) => `greenhouse-join-ack:${userId}:${machineId}`;

export function joinAcknowledged(userId: string, machineId: string): boolean {
	return read(joinKey(userId, machineId));
}

export function acknowledgeJoin(userId: string, machineId: string) {
	write(joinKey(userId, machineId));
}

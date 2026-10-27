export type Traffic = { values: number[]; label: string; format?: (v: number) => string };

export function trafficFormatter(label: string): (v: number) => string {
	const unit = label.match(/^[\d.,]*k?(.*)$/)?.[1] ?? '';
	return (v) => {
		const n = Math.round(v);
		return `${n > 999 ? `${(n / 1000).toFixed(1)}k` : n}${unit}`;
	};
}

export function trafficReading(traffic: Traffic, index: number | null) {
	const format = traffic.format ?? trafficFormatter(traffic.label);
	const hovered = index === null ? undefined : traffic.values[index];
	return {
		text: hovered === undefined ? traffic.label : format(hovered),
		scrubbing: hovered !== undefined,
		width: Math.max(traffic.label.length, ...traffic.values.map((v) => format(v).length))
	};
}

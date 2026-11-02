export type ConnectionFormat = 'uri' | 'psql' | 'env' | 'jdbc';

export type ConnectionTarget = {
	user: string;
	host: string;
	port: number | string;
	database: string;
	query?: string;
};

const JDBC_VERIFIED_TLS = 'sslmode=verify-full&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory';

export function parsePublicAddress(
	uri: string | null | undefined
): { host: string; port: string; query: string } | null {
	const match = uri?.match(/@([^@/:]+):(\d+)\/[^?]*(?:\?(.*))?$/);
	return match ? { host: match[1], port: match[2], query: match[3] ?? '' } : null;
}

function jdbcQuery(query: string): string {
	return query.includes('sslmode=verify-full') ? JDBC_VERIFIED_TLS : query;
}

export function formatConnection(
	format: ConnectionFormat,
	target: ConnectionTarget,
	password: string
): string {
	const { user, host, port, database, query = '' } = target;
	if (format === 'jdbc') {
		const params = [`user=${user}`, `password=${password}`, jdbcQuery(query)].filter(Boolean);
		return `jdbc:postgresql://${host}:${port}/${database}?${params.join('&')}`;
	}
	const uri = `postgresql://${user}:${password}@${host}:${port}/${database}${query ? `?${query}` : ''}`;
	if (format === 'psql') return `psql "${uri}"`;
	if (format === 'env') return `DATABASE_URL="${uri}"`;
	return uri;
}

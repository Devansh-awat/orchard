export const TELEMETRY_PITCH =
	'Send the Orchard team a short, anonymous report once a day. It tells us which features people rely on and which crashes to fix first.';

export const TELEMETRY_SENT: string[] = [
	'Which versions of Orchard and Node.js are running, on which CPU architecture.',
	'How many users there are, and how many were active in the last day, week and month.',
	'How many organizations, projects, deployments, databases, jobs and nodes exist, plus similar counts from installed grafts.',
	'How many builds succeeded and failed in the last 24 hours.',
	'Whether GitHub, email, backups, SSO, MCP and node scheduling are turned on.',
	'For an unexpected server error, its type, the route pattern, and the file, function and line in Orchard where it happened.'
];

export const TELEMETRY_NEVER =
	'Only counts and yes/no answers. No names, emails, domains, repositories, environment variables, logs or error messages. IP addresses are not stored. Every report carries a random ID made for this instance, nothing that points back to you.';

export const TELEMETRY_ENV_NOTE =
	'ORCHARD_TELEMETRY=false turns this off for good and locks the setting.';

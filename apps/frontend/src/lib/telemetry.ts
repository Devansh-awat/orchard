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

export const TELEMETRY_NEVER = 'Orchard collects nothing from users unless statistics are enabled.';

export const TELEMETRY_DOCS_URL = 'https://docs.orchard.hackclub.com/operate/telemetry/';

export const TELEMETRY_ENV_NOTE =
	'Set ORCHARD_TELEMETRY=false to turn this off and lock the setting.';

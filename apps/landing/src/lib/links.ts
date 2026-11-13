export const links = {
	install: 'https://docs.orchard.hackclub.com/start/install/',
	docs: 'https://docs.orchard.hackclub.com',
	mcp: 'https://docs.orchard.hackclub.com/mcp/',
	cli: 'https://docs.orchard.hackclub.com/reference/cli/',
	status: 'https://status.orchard.my',
	github: 'https://github.com/hackclub/orchard',
	readme: 'https://github.com/hackclub/orchard#readme',
	license: 'https://github.com/hackclub/orchard/blob/main/LICENSE',
	credits: '/credits',
	compare: '/compare',
	selfHostedPaas: '/self-hosted-paas',
	templates: '/templates',
	submitTemplate: 'https://github.com/hackclub/orchard/tree/main/registry',
	templateReference: 'https://docs.orchard.hackclub.com/run/templates/',
	extensions: '/extensions',
	graftsOverview: 'https://docs.orchard.hackclub.com/grafts/overview/',
	graftsInstall: 'https://docs.orchard.hackclub.com/grafts/install/',
	graftsBuild: 'https://docs.orchard.hackclub.com/grafts/build/quickstart/',
	notices: '/third-party-notices.txt',
	changelog: 'https://github.com/hackclub/orchard/blob/main/CHANGELOG.md',
	security: 'https://docs.orchard.hackclub.com/operate/security/',
	telemetry: 'https://docs.orchard.hackclub.com/operate/telemetry/',
	issues: 'https://github.com/hackclub/orchard/issues/new',
	hackclub: 'https://hackclub.com',
	joinHackClub: 'https://slack.hackclub.com',
	conduct: 'https://hackclub.com/conduct/',
	privacy: 'https://hackclub.com/privacy-and-terms/',
	imprint: 'https://hackclub.com/imprint/',
	author: 'https://github.com/LeafdTK'
};

export const installPrompt =
	'Install Orchard on my server following https://docs.orchard.hackclub.com/start/install.md. Ask me before anything that is not reversible.';

export const installScript =
	'curl -fsSL https://assets.orchard.my/install.sh -o orchard-install.sh && sudo bash orchard-install.sh';

export const brewInstall = 'brew install --cask leafdtk/tap/orchard-cli';

export const links = {
	install: 'https://docs.orchard.my/start/install/',
	docs: 'https://docs.orchard.my',
	mcp: 'https://docs.orchard.my/mcp/',
	cli: 'https://docs.orchard.my/reference/cli/',
	status: 'https://status.orchard.my',
	github: 'https://github.com/hackclub/orchard',
	readme: 'https://github.com/hackclub/orchard#readme',
	license: 'https://github.com/hackclub/orchard/blob/main/LICENSE',
	credits: '/credits',
	templates: '/templates',
	submitTemplate: 'https://github.com/hackclub/orchard/tree/main/registry',
	templateReference: 'https://docs.orchard.my/run/templates/',
	extensions: '/extensions',
	graftsOverview: 'https://docs.orchard.my/grafts/overview/',
	graftsInstall: 'https://docs.orchard.my/grafts/install/',
	graftsBuild: 'https://docs.orchard.my/grafts/build/quickstart/',
	notices: '/third-party-notices.txt',
	changelog: 'https://github.com/hackclub/orchard/blob/main/CHANGELOG.md',
	security: 'https://docs.orchard.my/operate/security/',
	issues: 'https://github.com/hackclub/orchard/issues/new',
	hackclub: 'https://hackclub.com',
	joinHackClub: 'https://slack.hackclub.com',
	conduct: 'https://hackclub.com/conduct/',
	privacy: 'https://hackclub.com/privacy-and-terms/',
	imprint: 'https://hackclub.com/imprint/',
	author: 'https://github.com/LeafdTK'
};

export const installPrompt =
	'Install Orchard on my server following https://docs.orchard.my/start/install.md. Ask me before anything that is not reversible.';

export const installScript =
	'curl -fsSL https://assets.orchard.my/install.sh -o orchard-install.sh && sudo bash orchard-install.sh';

export const brewInstall = 'brew install --cask leafdtk/tap/orchard-cli';

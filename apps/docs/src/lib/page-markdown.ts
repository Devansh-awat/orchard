import { AGENT_SETUP, clients, examplePrompts, urlOptions } from './agent-setup';
import { changeHref, formatDate, getChanges, getFeatured, groupByDate } from './changelog';
import { DIRECTORY_TEXT, directory, directoryGroups } from './directory';
import { AGENT_PANEL, HERO_TEXT, TABS_HEADING, WHATS_NEW, homeTabs } from './home';
import { INSTALL_PROMPT, MCP_URL, SETUP_PROMPT, SITE_URL } from './nav';

function fence(code: string, lang = ''): string {
  return `\`\`\`${lang}\n${code}\n\`\`\``;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `   ${line}` : line))
    .join('\n');
}

export function homeMarkdown(): string {
  const parts = [
    '# Orchard Docs',
    '',
    `> ${HERO_TEXT}`,
    '',
    `Source: ${SITE_URL}/`,
    '',
    '- [Get started](/start/install/)',
    '- [Agent setup](/agent-setup/)',
    '- [Directory](/directory/)',
    '- [Changelog](/changelog/)',
    '',
    '## Install with an agent',
    '',
    'Paste this prompt into your coding agent:',
    '',
    fence(INSTALL_PROMPT, 'text'),
    '',
    `## ${TABS_HEADING}`,
    ''
  ];
  for (const tab of homeTabs) {
    parts.push(`### ${tab.label}: ${tab.heading}`, '', tab.text, '', fence(tab.command, 'sh'), '');
    parts.push(`- [${tab.primary.label}](${tab.primary.href})`);
    for (const link of tab.related) parts.push(`- [${link.label}](${link.href})`);
    parts.push('');
  }
  parts.push(
    `## ${AGENT_PANEL.heading}`,
    '',
    AGENT_PANEL.text,
    '',
    fence(INSTALL_PROMPT, 'text'),
    ''
  );
  parts.push(`[${AGENT_PANEL.sideLink}](/agent-setup/)`, '');
  parts.push(`## ${WHATS_NEW.heading}`, '', WHATS_NEW.text, '');
  for (const change of getFeatured(8)) {
    parts.push(`- ${change.date}, ${change.component}: [${change.text}](${changeHref(change)})`);
  }
  parts.push('', `[${WHATS_NEW.link}](/changelog/)`, '');
  return parts.join('\n');
}

export function agentSetupMarkdown(): string {
  const parts = [
    `# ${AGENT_SETUP.title}`,
    '',
    `> ${AGENT_SETUP.description}`,
    '',
    `Source: ${SITE_URL}/agent-setup/`,
    '',
    'Paste this prompt into your coding agent:',
    '',
    fence(SETUP_PROMPT, 'text'),
    '',
    `## ${AGENT_SETUP.urlHeading}`,
    '',
    AGENT_SETUP.urlText,
    '',
    fence(`${MCP_URL}/`, 'text'),
    '',
    `## ${AGENT_SETUP.pickHeading}`,
    ''
  ];
  for (const client of clients) {
    parts.push(`### ${client.name}`, '');
    client.steps.forEach((step, index) => {
      parts.push(`${index + 1}. ${step.text}`);
      if (step.code) {
        parts.push('', indent(fence(step.code, step.code.startsWith('{') ? 'json' : 'sh')));
      }
      parts.push('');
    });
  }
  parts.push(`## ${AGENT_SETUP.limitHeading}`, '', AGENT_SETUP.limitText, '');
  for (const option of urlOptions) parts.push(`- ${option.label}: \`${option.code}\``);
  parts.push('', `## ${AGENT_SETUP.promptsHeading}`, '', AGENT_SETUP.promptsText, '');
  for (const example of examplePrompts) {
    parts.push(`### ${example.title}`, '', example.text, '', fence(example.prompt, 'text'), '');
    parts.push(`Tools: ${example.tools.map((tool) => `\`${tool}\``).join(', ')}`, '');
  }
  parts.push(
    '## More',
    '',
    '- [MCP for agents](/mcp.md)',
    '- [MCP tools](/reference/mcp-tools.md)',
    '- [Code mode for agents](/agents-code-mode.md)',
    ''
  );
  return parts.join('\n');
}

export function directoryMarkdown(): string {
  const parts = [
    '# Directory',
    '',
    `> ${DIRECTORY_TEXT}`,
    '',
    `Source: ${SITE_URL}/directory/`,
    ''
  ];
  for (const group of directoryGroups) {
    parts.push(`## ${group}`, '');
    for (const item of directory.filter((entry) => entry.group === group)) {
      parts.push(`- [${item.title}](${item.href}): ${item.text}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

export function changelogMarkdown(): string {
  const parts = [
    '# Changelog',
    '',
    '> New features and fixes in Orchard.',
    '',
    `Source: ${SITE_URL}/changelog/`,
    '',
    `RSS: ${SITE_URL}/changelog/index.xml`,
    ''
  ];
  for (const group of groupByDate(getChanges())) {
    parts.push(`## ${formatDate(group.date, true, false)}`, '');
    for (const change of group.changes) {
      parts.push(
        `- ${change.type}, ${change.component}: ${change.text}${change.detail ? `. ${change.detail}` : ''}`
      );
    }
    parts.push('');
  }
  return parts.join('\n');
}

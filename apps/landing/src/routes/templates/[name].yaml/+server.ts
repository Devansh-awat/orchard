import { error, redirect } from '@sveltejs/kit';
import { registryHref } from '$lib/server/registry';
import type { RequestHandler } from './$types';

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const GET: RequestHandler = ({ params }) => {
	if (!NAME.test(params.name)) error(404, 'No template by that name');
	redirect(302, registryHref(`templates/${params.name}/latest/template.yaml`));
};

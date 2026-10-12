import type { RequestHandler } from './$types';
import { graftAsset } from '$lib/server/grafts';

export const GET: RequestHandler = ({ params }) =>
	graftAsset(params.id, params.digest, params.file);

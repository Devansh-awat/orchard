export type StorageProviderId = 'aws' | 'r2' | 'b2' | 'hetzner' | 'other';

export interface StorageProvider {
	id: StorageProviderId;
	label: string;
	placeLabel: string | null;
	placeDefault: string;
	endpoint: (place: string) => string;
	region: (place: string) => string;
	pathStyle: boolean;
}

export const STORAGE_PROVIDERS: StorageProvider[] = [
	{
		id: 'aws',
		label: 'Amazon S3',
		placeLabel: 'Region',
		placeDefault: 'us-east-1',
		endpoint: (place) => `https://s3.${place}.amazonaws.com`,
		region: (place) => place,
		pathStyle: false
	},
	{
		id: 'r2',
		label: 'Cloudflare R2',
		placeLabel: 'Account ID',
		placeDefault: '',
		endpoint: (place) => (place ? `https://${place}.r2.cloudflarestorage.com` : ''),
		region: () => 'auto',
		pathStyle: true
	},
	{
		id: 'b2',
		label: 'Backblaze B2',
		placeLabel: 'Region',
		placeDefault: 'us-west-004',
		endpoint: (place) => `https://s3.${place}.backblazeb2.com`,
		region: (place) => place,
		pathStyle: true
	},
	{
		id: 'hetzner',
		label: 'Hetzner Object Storage',
		placeLabel: 'Location',
		placeDefault: 'fsn1',
		endpoint: (place) => `https://${place}.your-objectstorage.com`,
		region: (place) => place,
		pathStyle: true
	},
	{
		id: 'other',
		label: 'MinIO or another S3 service',
		placeLabel: null,
		placeDefault: '',
		endpoint: () => '',
		region: () => 'us-east-1',
		pathStyle: true
	}
];

export function storageProvider(id: string): StorageProvider {
	return STORAGE_PROVIDERS.find((p) => p.id === id) ?? STORAGE_PROVIDERS[0];
}

export function storageConnection(
	id: string,
	place: string,
	bucket: string,
	custom: { endpoint?: string; region?: string; accessKeyId?: string; secretAccessKey?: string }
): Record<string, string> {
	const provider = storageProvider(id);
	const spot = place.trim() || provider.placeDefault;
	const trimmedBucket = bucket.trim();
	return {
		endpoint: provider.placeLabel ? provider.endpoint(spot) : (custom.endpoint ?? '').trim(),
		region: provider.placeLabel
			? provider.region(spot)
			: (custom.region ?? '').trim() || provider.region(spot),
		pathStyle: String(provider.pathStyle),
		backupBucket: trimmedBucket,
		bucketName: trimmedBucket,
		accessKeyId: (custom.accessKeyId ?? '').trim(),
		secretAccessKey: custom.secretAccessKey ?? ''
	};
}

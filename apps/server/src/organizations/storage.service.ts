import { Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { objectStorage, objectStorageGeneration } from '../instance-config/object-storage';

@Injectable()
export class StorageService {
  private s3Client: S3Client | null = null;

  private bucketName: string | null = null;

  private initializedAt = -1;

  private initialize() {
    const generation = objectStorageGeneration();
    if (this.initializedAt === generation) {
      return;
    }

    const { accessKeyId, secretAccessKey, bucketName, endpoint } = objectStorage();

    if (!accessKeyId || !secretAccessKey || !bucketName || !endpoint) {
      throw new Error(
        'Object storage is not configured. Set it under Instance admin, or with the R2_* environment variables.'
      );
    }

    this.bucketName = bucketName;

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    });

    this.initializedAt = generation;
  }

  async uploadFile(file: Express.Multer.File, folder = 'organizations'): Promise<string> {
    this.initialize();

    if (!this.s3Client || !this.bucketName) {
      throw new Error('R2 storage is not configured');
    }

    const fileExtension = file.originalname.split('.').pop();
    const fileName = `${folder}/${randomUUID()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: 'public, max-age=31536000, immutable'
    });

    await this.s3Client.send(command);

    const publicUrl = objectStorage().publicUrl ?? '';

    return `${publicUrl}/${fileName}`;
  }

  async deleteFile(url: string): Promise<void> {
    this.initialize();

    if (!this.s3Client || !this.bucketName) {
      throw new Error('R2 storage is not configured');
    }

    const publicUrl = objectStorage().publicUrl ?? '';

    if (!url.startsWith(publicUrl)) {
      return;
    }

    const key = url.replace(`${publicUrl}/`, '');

    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key
    });

    await this.s3Client.send(command);
  }

  buildContextEnabled(): boolean {
    const flag = String(process.env.LOCAL_DEPLOYS_ENABLED || '').toLowerCase();
    if (flag !== 'true' && flag !== '1') {
      return false;
    }
    return Boolean(
      objectStorage().buildContextBucket &&
      objectStorage().accessKeyId &&
      objectStorage().secretAccessKey
    );
  }

  private contextBucket(): string {
    const bucket = objectStorage().buildContextBucket;
    if (!bucket) {
      throw new Error('No build context bucket is configured (R2_BUILD_CONTEXT_BUCKET)');
    }
    this.initializeContextClient();
    return bucket;
  }

  private initializeContextClient() {
    if (this.s3Client) return;
    const { accessKeyId, secretAccessKey, endpoint } = objectStorage();
    if (!accessKeyId || !secretAccessKey || !endpoint) {
      throw new Error('Object storage credentials are not configured');
    }
    this.s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey }
    });
  }

  async putBuildContext(key: string, body: Buffer): Promise<void> {
    const bucket = this.contextBucket();
    await this.s3Client!.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/gzip'
      })
    );
  }

  async signBuildContextGet(key: string, expiresInSeconds = 900): Promise<string> {
    const bucket = this.contextBucket();
    return getSignedUrl(this.s3Client! as any, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSeconds
    });
  }

  async deleteBuildContext(key: string): Promise<void> {
    const bucket = this.contextBucket();
    await this.s3Client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

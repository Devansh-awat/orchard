import { Injectable } from '@nestjs/common';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

@Injectable()
export class StorageService {
  private s3Client: S3Client | null = null;

  private bucketName: string | null = null;

  private initialized = false;

  private initialize() {
    if (this.initialized) {
      return;
    }

    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET_NAME;

    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error('R2 configuration is missing. Please set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME');
    }

    this.bucketName = bucket;

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.initialized = true;
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
      CacheControl: 'public, max-age=31536000, immutable',
    });

    await this.s3Client.send(command);

    const accountId = process.env.R2_ACCOUNT_ID;
    const publicUrl = process.env.R2_PUBLIC_URL || `https://pub-${accountId}.r2.dev`;
    
    return `${publicUrl}/${fileName}`;
  }

  async deleteFile(url: string): Promise<void> {
    this.initialize();

    if (!this.s3Client || !this.bucketName) {
      throw new Error('R2 storage is not configured');
    }

    const accountId = process.env.R2_ACCOUNT_ID;
    const publicUrl = process.env.R2_PUBLIC_URL || `https://pub-${accountId}.r2.dev`;
    
    if (!url.startsWith(publicUrl)) {
      return;
    }

    const key = url.replace(`${publicUrl}/`, '');

    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    await this.s3Client.send(command);
  }
}

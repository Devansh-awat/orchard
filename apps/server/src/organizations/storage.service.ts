import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { reencodeImage } from './image-reencode';
import {
  BuildContextStorage,
  LOCAL_DEPLOYS_NEED_S3,
  UploadStorage,
  buildContextStorage,
  objectStorageGeneration,
  s3ClientConfig,
  uploadStorage
} from '../instance-config/object-storage';
import { PrismaService } from '../prisma/prisma.service';
import { uploadKeyOf, keyInNamespace, isLegacyUploadKey } from './upload-namespace';
import { uploadReferencedElsewhere, type UploadOwner } from './upload-references';

export class StorageNotConfiguredError extends BadRequestException {
  constructor() {
    super('File uploads need storage. An instance admin can add it.');
  }
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  private uploadClient: { generation: number; client: S3Client; target: UploadStorage } | null =
    null;

  private contextClient: {
    generation: number;
    client: S3Client;
    target: BuildContextStorage;
  } | null = null;

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  uploadsEnabled(): boolean {
    return uploadStorage() !== null;
  }

  private uploads(): { client: S3Client; target: UploadStorage } {
    const generation = objectStorageGeneration();
    if (this.uploadClient?.generation === generation) return this.uploadClient;
    const target = uploadStorage();
    if (!target) throw new StorageNotConfiguredError();
    const client = new S3Client(s3ClientConfig(target));
    this.uploadClient = { generation, client, target };
    return this.uploadClient;
  }

  async uploadImage(file: Express.Multer.File, folder = 'organizations'): Promise<string> {
    const image = await reencodeImage(file.buffer);
    return this.uploadFile(
      {
        ...file,
        buffer: image.buffer,
        size: image.buffer.length,
        mimetype: image.contentType,
        originalname: `image.${image.extension}`
      },
      folder
    );
  }

  async uploadFile(file: Express.Multer.File, folder = 'organizations'): Promise<string> {
    const { client, target } = this.uploads();

    const fileExtension = file.originalname.split('.').pop();
    const fileName = `${folder}/${randomUUID()}.${fileExtension}`;

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: target.bucket,
          Key: `${target.keyPrefix}${fileName}`,
          Body: file.buffer,
          ContentType: file.mimetype,
          CacheControl: 'public, max-age=31536000, immutable'
        })
      );
    } catch (e: any) {
      this.logger.warn(`upload to ${target.bucket} failed: ${e?.name ?? 'error'}`);
      throw new ServiceUnavailableException("Storage isn't reachable right now. Try again later.");
    }

    return `${target.publicUrl}/${fileName}`;
  }

  async deleteFile(url: string, namespace: string): Promise<void> {
    if (!uploadStorage()) return;
    const { client, target } = this.uploads();

    const key = uploadKeyOf(url);
    if (key === null) return;
    if (!keyInNamespace(key, namespace)) {
      this.logger.warn(`refused to delete upload outside namespace ${namespace}`);
      return;
    }

    await client.send(
      new DeleteObjectCommand({
        Bucket: target.bucket,
        Key: `${target.keyPrefix}${key}`
      })
    );
  }

  async deleteReplaced(url: string, namespace: string, owner: UploadOwner): Promise<void> {
    if (!uploadStorage()) return;
    const key = uploadKeyOf(url);
    if (key === null) return;
    if (keyInNamespace(key, namespace)) {
      await this.deleteFile(url, namespace).catch((e: any) => {
        if (e?.name !== 'NoSuchKey' && e?.name !== 'NotFound') throw e;
      });
      return;
    }
    if (!isLegacyUploadKey(key)) {
      this.logger.warn(`refused to delete upload outside namespace ${namespace}`);
      return;
    }
    if (!this.prisma) {
      this.logger.warn('refused to delete a legacy upload without a way to check references');
      return;
    }
    if (await uploadReferencedElsewhere(this.prisma, key, owner)) return;
    const { client, target } = this.uploads();
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: target.bucket,
          Key: `${target.keyPrefix}${key}`
        })
      );
    } catch (e: any) {
      if (e?.name !== 'NoSuchKey' && e?.name !== 'NotFound') throw e;
    }
  }

  async readUpload(path: string): Promise<{
    body: Readable;
    contentType: string | undefined;
    length: number | undefined;
  } | null> {
    const target = uploadStorage();
    if (!target || target.keyPrefix === '') return null;
    const { client } = this.uploads();
    try {
      const out = await client.send(
        new GetObjectCommand({ Bucket: target.bucket, Key: `${target.keyPrefix}${path}` })
      );
      return {
        body: out.Body as Readable,
        contentType: out.ContentType,
        length: out.ContentLength
      };
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  buildContextEnabled(): boolean {
    return buildContextStorage() !== null;
  }

  private context(): { client: S3Client; target: BuildContextStorage } {
    const generation = objectStorageGeneration();
    if (this.contextClient?.generation === generation) return this.contextClient;
    const target = buildContextStorage();
    if (!target) throw new BadRequestException(LOCAL_DEPLOYS_NEED_S3);
    const client = new S3Client(s3ClientConfig(target));
    this.contextClient = { generation, client, target };
    return this.contextClient;
  }

  async putBuildContext(key: string, body: Buffer): Promise<void> {
    const { client, target } = this.context();
    await client.send(
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/gzip'
      })
    );
  }

  async signBuildContextGet(key: string, expiresInSeconds = 900): Promise<string> {
    const { client, target } = this.context();
    return getSignedUrl(client as any, new GetObjectCommand({ Bucket: target.bucket, Key: key }), {
      expiresIn: expiresInSeconds
    });
  }

  async deleteBuildContext(key: string): Promise<void> {
    const { client, target } = this.context();
    await client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key }));
  }
}

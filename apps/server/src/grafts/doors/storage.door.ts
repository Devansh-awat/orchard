import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER, ModuleRef } from '@nestjs/core';
import { uploadStorage } from '../../instance-config/object-storage';
import { StorageService } from '../../organizations/storage.service';
import { bindGraft, type DoorMeta } from './door';

const EXTENSION = /^[a-z0-9]{1,10}$/;

@Injectable({ scope: Scope.TRANSIENT })
export class StorageDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'storage',
    version: 1,
    status: 'stable',
    capability: 'storage'
  };

  private readonly graftId: string;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef
  ) {
    this.graftId = bindGraft(parent, StorageDoorV1.meta).id;
  }

  private get _storage(): StorageService {
    return this.moduleRef.get(StorageService, { strict: false });
  }

  get configured(): boolean {
    return uploadStorage() !== null;
  }

  get publicBase(): string | null {
    const target = uploadStorage();
    return target ? `${target.publicUrl}/${this.graftId}/` : null;
  }

  owns(url: string): boolean {
    const base = this.publicBase;
    return (
      !!base &&
      typeof url === 'string' &&
      url.startsWith(base) &&
      !url.slice(base.length).includes('..')
    );
  }

  async upload(file: {
    data: Uint8Array;
    contentType: string;
    extension: string;
  }): Promise<string> {
    const extension = file.extension.toLowerCase();
    if (!EXTENSION.test(extension)) throw new Error(`invalid file extension "${file.extension}"`);
    return this._storage.uploadFile(
      {
        buffer: Buffer.from(file.data),
        mimetype: file.contentType,
        originalname: `upload.${extension}`,
        size: file.data.byteLength
      } as Express.Multer.File,
      this.graftId
    );
  }

  async delete(url: string): Promise<void> {
    if (!this.owns(url)) throw new Error(`graft ${this.graftId} can only delete its own files`);
    await this._storage.deleteFile(url);
  }
}

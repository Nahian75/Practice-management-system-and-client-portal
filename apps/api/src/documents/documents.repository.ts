import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { SealedSecret } from '../common/crypto/secret-box.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, DocumentCategory, DocumentMediaType, MatterStatus } from '../database/schema.js';
import { visibleTo } from '../matters/matters.repository.js';

export interface NewDocument {
  matterId: string;
  title: string;
  category: DocumentCategory;
  createdBy: string;
}

export interface NewVersion {
  fileName: string;
  mediaType: DocumentMediaType;
  sizeBytes: number;
  sha256: Buffer;
  storageKey: string;
  sealedKey: SealedSecret;
}

@Injectable()
export class DocumentsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  /** The matter's status and reference, if `viewerId` is on its team, under the matters module's own rule. */
  matterOnTeam(matterId: string, viewerId: string): Promise<{ status: MatterStatus; reference: string } | undefined> {
    return this.db
      .selectFrom('matters')
      .select(['matters.status', 'matters.reference'])
      .where('matters.id', '=', matterId)
      .where(visibleTo(viewerId))
      .executeTakeFirst();
  }

  /** Records a document and its first version. The database checks the team and that the matter is open. */
  async insert(document: NewDocument, version: NewVersion, trx: Kysely<Database>) {
    const created = await trx
      .insertInto('documents')
      .values({ matter_id: document.matterId, title: document.title, category: document.category, created_by: document.createdBy })
      .returning(['id', 'title', 'category', 'created_at'])
      .executeTakeFirstOrThrow();
    const first = await trx
      .insertInto('document_versions')
      .values({
        document_id: created.id,
        file_name: version.fileName,
        media_type: version.mediaType,
        size_bytes: version.sizeBytes,
        sha256: version.sha256,
        storage_key: version.storageKey,
        key_version: version.sealedKey.keyVersion,
        key_nonce: version.sealedKey.nonce,
        wrapped_key: version.sealedKey.ciphertext,
        key_tag: version.sealedKey.authTag,
        uploaded_by: document.createdBy,
      })
      .returning(['number', 'uploaded_at'])
      .executeTakeFirstOrThrow();
    return { ...created, version: first };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { SealedSecret } from '../common/crypto/secret-box.js';
import { DATABASE } from '../database/database.module.js';
import type { Database, DocumentCategory, DocumentMediaType, MatterStatus } from '../database/schema.js';
import { visibleTo } from '../matters/matters.repository.js';

export interface VersionSummary {
  number: number;
  fileName: string;
  mediaType: DocumentMediaType;
  sizeBytes: number;
  uploadedAt: Date;
}

export interface DocumentSummary {
  id: string;
  title: string;
  category: DocumentCategory;
  createdAt: Date;
  latest: VersionSummary;
}

export interface DocumentDetails {
  id: string;
  matterId: string;
  title: string;
  category: DocumentCategory;
  createdAt: Date;
  sharedWithClient: boolean;
  versions: (VersionSummary & { uploadedBy: { accountId: string; displayName: string } })[];
  withdrawal: { withdrawnBy: { accountId: string; displayName: string }; reason: string; withdrawnAt: Date } | null;
}

/** What deciding on a change to a document needs, for someone on its matter's team. */
export interface DocumentForChange {
  matterId: string;
  matterStatus: MatterStatus;
  matterReference: string;
  createdBy: string;
  withdrawn: boolean;
  sharedWithClient: boolean;
  viewerSupervises: boolean;
}

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
    const first = await this.insertVersion(created.id, version, document.createdBy, trx);
    return { ...created, version: first };
  }

  /**
   * One page of the matter's documents, newest first, each with its latest
   * version, if `viewerId` is on its team. Ids are time-ordered (uuidv7), so
   * `before` (an id from the previous page) continues where it stopped.
   */
  async listForMatter(matterId: string, viewerId: string, page: { before?: string; limit: number }): Promise<DocumentSummary[] | undefined> {
    if (!(await this.matterOnTeam(matterId, viewerId))) {
      return undefined;
    }
    const rows = await this.db
      .selectFrom('documents')
      .innerJoin('document_versions', 'document_versions.document_id', 'documents.id')
      .select([
        'documents.id',
        'documents.title',
        'documents.category',
        'documents.created_at',
        'document_versions.number',
        'document_versions.file_name',
        'document_versions.media_type',
        'document_versions.size_bytes',
        'document_versions.uploaded_at',
      ])
      .where('documents.matter_id', '=', matterId)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('document_withdrawals').select('document_withdrawals.id').whereRef('document_withdrawals.document_id', '=', 'documents.id'))),
      )
      .where('document_versions.number', '=', (eb) =>
        eb.selectFrom('document_versions as latest').select((latest) => latest.fn.max('latest.number').as('number')).whereRef('latest.document_id', '=', 'documents.id'),
      )
      .$if(page.before !== undefined, (query) => query.where('documents.id', '<', page.before as string))
      .orderBy('documents.id', 'desc')
      .limit(page.limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      createdAt: row.created_at,
      latest: { number: row.number, fileName: row.file_name, mediaType: row.media_type, sizeBytes: row.size_bytes, uploadedAt: row.uploaded_at },
    }));
  }

  /** A document and every version, oldest first, if `viewerId` is on its matter's team. */
  async findVisible(documentId: string, viewerId: string): Promise<DocumentDetails | undefined> {
    const document = await this.db
      .selectFrom('documents')
      .innerJoin('matters', 'matters.id', 'documents.matter_id')
      .select(['documents.id', 'documents.matter_id', 'documents.title', 'documents.category', 'documents.created_at', 'documents.shared_with_client'])
      .where('documents.id', '=', documentId)
      .where(visibleTo(viewerId))
      .executeTakeFirst();
    if (!document) {
      return undefined;
    }
    const versions = await this.db
      .selectFrom('document_versions')
      .innerJoin('accounts', 'accounts.id', 'document_versions.uploaded_by')
      .select([
        'document_versions.number',
        'document_versions.file_name',
        'document_versions.media_type',
        'document_versions.size_bytes',
        'document_versions.uploaded_at',
        'document_versions.uploaded_by',
        'accounts.display_name',
      ])
      .where('document_versions.document_id', '=', documentId)
      .orderBy('document_versions.number')
      .execute();
    const withdrawal = await this.db
      .selectFrom('document_withdrawals')
      .innerJoin('accounts', 'accounts.id', 'document_withdrawals.withdrawn_by')
      .select(['document_withdrawals.withdrawn_by', 'accounts.display_name', 'document_withdrawals.reason', 'document_withdrawals.withdrawn_at'])
      .where('document_withdrawals.document_id', '=', documentId)
      .executeTakeFirst();
    return {
      id: document.id,
      matterId: document.matter_id,
      title: document.title,
      category: document.category,
      createdAt: document.created_at,
      sharedWithClient: document.shared_with_client,
      withdrawal: withdrawal
        ? {
            withdrawnBy: { accountId: withdrawal.withdrawn_by, displayName: withdrawal.display_name },
            reason: withdrawal.reason,
            withdrawnAt: withdrawal.withdrawn_at,
          }
        : null,
      versions: versions.map((version) => ({
        number: version.number,
        fileName: version.file_name,
        mediaType: version.media_type,
        sizeBytes: version.size_bytes,
        uploadedAt: version.uploaded_at,
        uploadedBy: { accountId: version.uploaded_by, displayName: version.display_name },
      })),
    };
  }

  /** The document's matter and state, if `viewerId` is on its matter's team. */
  async findForChange(documentId: string, viewerId: string): Promise<DocumentForChange | undefined> {
    const row = await this.db
      .selectFrom('documents')
      .innerJoin('matters', 'matters.id', 'documents.matter_id')
      .select(({ exists, selectFrom }) => [
        'documents.matter_id',
        'documents.created_by',
        'documents.shared_with_client',
        'matters.status',
        'matters.reference',
        exists(selectFrom('document_withdrawals').select('document_withdrawals.id').whereRef('document_withdrawals.document_id', '=', 'documents.id')).as(
          'withdrawn',
        ),
        exists(
          selectFrom('matter_team')
            .select('matter_team.id')
            .whereRef('matter_team.matter_id', '=', 'documents.matter_id')
            .where('matter_team.account_id', '=', viewerId)
            .where('matter_team.role', '=', 'supervising_partner')
            .where('matter_team.removed_at', 'is', null),
        ).as('supervises'),
      ])
      .where('documents.id', '=', documentId)
      .where(visibleTo(viewerId))
      .executeTakeFirst();
    return row
      ? {
          matterId: row.matter_id,
          matterStatus: row.status,
          matterReference: row.reference,
          createdBy: row.created_by,
          withdrawn: Boolean(row.withdrawn),
          sharedWithClient: row.shared_with_client,
          viewerSupervises: Boolean(row.supervises),
        }
      : undefined;
  }

  /** Records a new version. The database numbers it, and checks the team, that the matter is open and the document not withdrawn. */
  insertVersion(documentId: string, version: NewVersion, uploadedBy: string, trx: Kysely<Database>) {
    return trx
      .insertInto('document_versions')
      .values({
        document_id: documentId,
        file_name: version.fileName,
        media_type: version.mediaType,
        size_bytes: version.sizeBytes,
        sha256: version.sha256,
        storage_key: version.storageKey,
        key_version: version.sealedKey.keyVersion,
        key_nonce: version.sealedKey.nonce,
        wrapped_key: version.sealedKey.ciphertext,
        key_tag: version.sealedKey.authTag,
        uploaded_by: uploadedBy,
      })
      .returning(['number', 'uploaded_at'])
      .executeTakeFirstOrThrow();
  }

  /** Records a withdrawal. The database checks who may, that the matter is open, and that it happens once. */
  async withdraw(documentId: string, withdrawnBy: string, reason: string, trx: Kysely<Database>): Promise<void> {
    await trx.insertInto('document_withdrawals').values({ document_id: documentId, withdrawn_by: withdrawnBy, reason }).execute();
  }

  /** Records a real change; the database updates the setting and drops repeats. */
  async changeSharing(documentId: string, shared: boolean, changedBy: string, trx: Kysely<Database>): Promise<boolean> {
    const change = await trx
      .insertInto('document_sharing_changes')
      .values({ document_id: documentId, shared, changed_by: changedBy })
      .returning('id')
      .executeTakeFirst();
    return change !== undefined;
  }

  /** What is needed to send one version as a download, if `viewerId` is on its matter's team. */
  findVersionToDownload(documentId: string, number: number, viewerId: string) {
    return this.db
      .selectFrom('document_versions')
      .innerJoin('documents', 'documents.id', 'document_versions.document_id')
      .innerJoin('matters', 'matters.id', 'documents.matter_id')
      .select([
        'documents.matter_id',
        'document_versions.file_name',
        'document_versions.media_type',
        'document_versions.size_bytes',
        'document_versions.storage_key',
        'document_versions.key_version',
        'document_versions.key_nonce',
        'document_versions.wrapped_key',
        'document_versions.key_tag',
      ])
      .select(({ exists, selectFrom }) =>
        exists(selectFrom('document_withdrawals').select('document_withdrawals.id').whereRef('document_withdrawals.document_id', '=', 'documents.id')).as(
          'withdrawn',
        ),
      )
      .where('document_versions.document_id', '=', documentId)
      .where('document_versions.number', '=', number)
      .where(visibleTo(viewerId))
      .executeTakeFirst();
  }
}

export type RefusalReason = 'empty' | 'too_large' | 'type' | 'macros' | 'active_content' | 'unscannable';

/** The file is not accepted, for `reason`. Nothing of it is kept. */
export class FileRefusedError extends Error {
  override readonly name = 'FileRefusedError';

  constructor(readonly reason: RefusalReason) {
    super(`File refused: ${reason}`);
  }
}

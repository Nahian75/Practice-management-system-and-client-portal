import { isReason, MATTER_REFERENCE_PATTERN, REASON_MESSAGE } from '@/lib/matters';

/**
 * The two fields for reaching a matter one is not on the team of: its
 * reference, from the file, and why. Both the supervision takeover and
 * compliance access use them; the API records the reason.
 */
export function ReferenceAndReasonFields({ reasonLabel, reasonHint }: { reasonLabel: string; reasonHint: string }) {
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="matterReference">
          Matter reference
        </label>
        <span className="hint" id="matterReference-hint">
          For example C-000123/001
        </span>
        <input
          className="input input-short"
          id="matterReference"
          name="matterReference"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="matterReference-hint"
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="reason">
          {reasonLabel}
        </label>
        <span className="hint" id="reason-hint">
          {reasonHint}
        </span>
        <textarea className="input" id="reason" name="reason" rows={3} maxLength={500} aria-describedby="reason-hint" />
      </div>
    </>
  );
}

/** The reference and reason from the form, or what is wrong with them. */
export function referenceAndReasonFrom(form: FormData): { matterReference: string; reason: string } | { problems: string[] } {
  const matterReference = String(form.get('matterReference') ?? '').trim();
  const reason = String(form.get('reason') ?? '').trim();
  const problems = [
    ...(MATTER_REFERENCE_PATTERN.test(matterReference) ? [] : ['Enter the matter reference, such as C-000123/001']),
    ...(isReason(reason) ? [] : [REASON_MESSAGE]),
  ];
  return problems.length > 0 ? { problems } : { matterReference, reason };
}

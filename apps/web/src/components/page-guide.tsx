'use client';

import { usePathname } from 'next/navigation';
import { guideForPath } from '@/lib/page-guides';

/** Native disclosure stays keyboard accessible and needs no storage or user tracking. */
export function PageGuide() {
  const pathname = usePathname();
  const guide = guideForPath(pathname);
  if (!guide) return null;

  return (
    <aside className="page-guide" aria-label="Page instructions">
      <details key={pathname}>
        <summary>
          <span className="guide-icon" aria-hidden="true">?</span>
          <span className="guide-summary"><strong>How to use this page</strong><span>{guide.title}</span></span>
          <span className="guide-toggle" aria-hidden="true">View steps <span>+</span></span>
        </summary>
        <div className="guide-content">
          <p>{guide.description}</p>
          <ol className="guide-steps">{guide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <p className="guide-reminder"><strong>Remember:</strong> {guide.reminder}</p>
          <p className="guide-permissions">Only actions allowed by your account and the record’s status are available. Ask your supervisor if you need access.</p>
        </div>
      </details>
    </aside>
  );
}

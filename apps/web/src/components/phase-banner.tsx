import type { ReactNode } from 'react';

/** A short description of the current application area. */
export function PhaseBanner({
  phase = 'STAFF WORKSPACE',
  children,
}: {
  phase?: string;
  children?: ReactNode;
}) {
  return (
    <div className="phase-banner" role="complementary" aria-label="Application area">
      <div className="phase-banner-inner">
        <span className="phase-tag">{phase}</span>
        <span className="phase-text">
          {children ?? (
            <>Access is limited by your assigned roles and matters.</>
          )}
        </span>
      </div>
    </div>
  );
}

import type { Metadata } from 'next';
import { ComplianceAccessForm } from './compliance-access-form';

export const metadata: Metadata = { title: 'Compliance access' };

export default function ComplianceAccessPage() {
  return (
    <>
      <h1>Look at a matter as compliance</h1>
      <p>
        For compliance. Any matter can be looked at, read-only, with a reason. Each look is recorded, the supervising
        partner is emailed, and there is a limit of 30 an hour.
      </p>
      <ComplianceAccessForm />
    </>
  );
}

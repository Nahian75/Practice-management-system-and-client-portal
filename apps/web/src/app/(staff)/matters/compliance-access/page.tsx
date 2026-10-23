import type { Metadata } from 'next';
import { HowTo } from '@/components/how-to';
import { ComplianceAccessForm } from './compliance-access-form';

export const metadata: Metadata = { title: 'Compliance access' };

export default function ComplianceAccessPage() {
  return (
    <>
      <h1>Look at a matter as compliance</h1>
      <HowTo>
        <li>Enter the matter reference from the file, and why you need to see it.</li>
        <li>The matter and its documents are shown once. Reloading the page hides them again.</li>
        <li>To download a document, choose it and give a reason for that download.</li>
        <li>Every look and every download is recorded, and the supervising partner is told.</li>
      </HowTo>
      <p>
        For compliance. Any matter can be looked at, read-only, with a reason. Each look is recorded, the supervising
        partner is emailed, and there is a limit of 30 an hour.
      </p>
      <ComplianceAccessForm />
    </>
  );
}

import type { Metadata } from 'next';
import { GuideLibrary } from '@/components/guide-library';

export const metadata: Metadata = { title: 'Help & guides' };

export default function HelpPage() {
  return <>
    <span className="caption">Learn at your own pace</span>
    <h1>Help &amp; guides</h1>
    <p className="secondary">Simple steps for everyday work. Search for a feature, or open a guide below. You can also find instructions at the top of each workspace page.</p>
    <div className="learning-path" aria-label="New case workflow">
      <strong>New to the system?</strong>
      <p>Follow this order for a new case:</p>
      <ol><li>Find or add the client</li><li>Complete onboarding and checks</li><li>Open the matter and obtain clearance</li><li>Manage tasks, documents and billing</li></ol>
    </div>
    <GuideLibrary />
    <p className="secondary">These guides explain the software. Follow the practice’s approved policies for legal, compliance and financial decisions. Access depends on your role.</p>
  </>;
}

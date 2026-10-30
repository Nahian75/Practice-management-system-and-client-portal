import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentAccount } from '@/lib/api';
import { SignInForm } from './sign-in-form';
import { LogoMark } from '@/components/logo-mark';
import { PageGuide } from '@/components/page-guide';
import { appName } from '@/config';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage() {
  const account = await currentAccount();
  if (account) {
    redirect(account.kind === 'client' ? '/portal' : '/');
  }

  return (
    <div className="sign-in-screen">
      <aside className="sign-in-brand" aria-label="About the workspace">
        <div className="sign-in-wordmark"><LogoMark /><span>{appName()}</span></div>
        <div className="sign-in-brand-content">
          <span className="sign-in-eyebrow">Practice management &amp; client portal</span>
          <h2>Client work.<br /><span>Connected.</span></h2>
          <p>A considered workspace for your team, your clients and every matter you manage.</p>
          <ul className="sign-in-features">
            <li><span aria-hidden="true">01</span><div><strong>A complete matter workspace</strong><p>Keep case details, documents and team tasks together.</p></div></li>
            <li><span aria-hidden="true">02</span><div><strong>A dedicated client portal</strong><p>Give clients access to the work shared with them.</p></div></li>
            <li><span aria-hidden="true">03</span><div><strong>Clear checks and approvals</strong><p>Follow the practice’s compliance and financial workflows.</p></div></li>
          </ul>
        </div>
        <div className="sign-in-brand-footer"><span>Built for legal practice</span><span>England &amp; Wales</span></div>
        <div className="sign-in-pattern" aria-hidden="true" />
      </aside>
      <div className="sign-in-access">
        <div className="sign-in-mobile-brand"><LogoMark /><span>{appName()}</span></div>
        <div className="sign-in-form-wrap">
          <SignInForm />
          <div className="sign-in-invitation"><strong>Joining for the first time?</strong><p>Use the invitation sent by your practice to set up your account. Contact them if you need a new invitation.</p></div>
          <PageGuide />
        </div>
        <div className="sign-in-access-footer"><span>&copy; {new Date().getFullYear()} {appName()}</span><span>Practice management &amp; client portal</span></div>
      </div>
    </div>
  );
}

import type { Metadata } from 'next';
import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = { title: 'Choose a new password' };

export default function ResetPasswordPage() {
  return (
    <>
      <h1>Choose a new password</h1>
      <ResetPasswordForm />
    </>
  );
}

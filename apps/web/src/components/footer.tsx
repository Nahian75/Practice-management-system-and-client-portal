import { LogoMark } from '@/components/logo-mark';
import { appName } from '@/config';

/** Identifies the application without making claims about the firm's regulatory status. */
export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="footer" role="contentinfo">
      <div className="footer-inner">
        <div className="footer-meta">
          <div className="footer-meta-item">
            <LogoMark className="logo-mark-footer" />
            <div className="footer-details">
              <p className="footer-title">{appName()} Practice Management System</p>
              <p className="footer-regulatory">
                Supports the practice&rsquo;s work in England and Wales. Regulatory status and client-care information are
                provided by the practice in its engagement documents.
              </p>
              <p className="footer-copyright">
                &copy; {currentYear} {appName()}.
              </p>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}

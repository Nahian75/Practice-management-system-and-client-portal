import { appName } from '@/config';

/** Identifies the application without making claims about the firm's regulatory status. */
export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="footer" role="contentinfo">
      <div className="footer-inner">
        <div className="footer-meta">
          <div className="footer-meta-item">
            <div className="footer-crest" aria-hidden="true">
              {/* Scales of Justice & British law heraldic emblem */}
              <svg
                width="36"
                height="36"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3v18" />
                <path d="M6 7h12" />
                <path d="M4 14l2-7 2 7a2 2 0 0 1-4 0z" />
                <path d="M16 14l2-7 2 7a2 2 0 0 1-4 0z" />
                <path d="M4 21h16" />
              </svg>
            </div>
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

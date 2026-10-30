/** Same geometry and colours as the downloadable logo and browser icon. */
export function LogoMark({ className = '' }: { className?: string }) {
  return <span className={['logo-mark', className].filter(Boolean).join(' ')} aria-hidden="true">
    <svg viewBox="0 0 64 64" width="48" height="48" fill="none" focusable="false">
      <rect width="64" height="64" rx="16" fill="#1e293b" />
      <path d="M44 13H27a11 11 0 0 0 0 22h10a5 5 0 0 1 0 10H20v6h17a11 11 0 0 0 0-22H27a5 5 0 0 1 0-10h17V13Z" fill="#f8fafc" />
    </svg>
  </span>;
}

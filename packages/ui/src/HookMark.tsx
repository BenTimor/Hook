export function HookMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={className} aria-hidden="true">
      <rect width="256" height="256" rx="58" fill="#191817" />
      <path
        d="M100 78V160C100 176 86 181 72 170M167 78V175M100 126H167"
        stroke="#fdf4df"
        strokeWidth="22"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

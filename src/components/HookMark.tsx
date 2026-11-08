export function HookMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={className} aria-hidden="true">
      <rect width="256" height="256" rx="58" fill="#1a1a19" />
      <path
        d="M170 64V156A46 46 0 0 1 78 156V138"
        stroke="#f6f6f3"
        strokeWidth="27"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

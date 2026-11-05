// inline mark so it inherits the theme's text colour — the static file is
// only used for the favicon and docs, where currentColor is unavailable
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 128 128" role="img" aria-label="Relic">
      <path
        d="M64 40 41 86M64 40l23 46M41 86h46"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <g fill="currentColor">
        <circle cx="64" cy="40" r="11" />
        <circle cx="41" cy="86" r="11" />
        <circle cx="87" cy="86" r="11" />
      </g>
      <circle cx="64" cy="71" r="4" fill="currentColor" />
    </svg>
  );
}

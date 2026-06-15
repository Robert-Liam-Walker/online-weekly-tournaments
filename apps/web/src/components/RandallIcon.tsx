export default function RandallIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <defs>
        <mask id="crescent-mask">
          {/* Full disc is visible... */}
          <circle cx="16" cy="16" r="13" fill="#fff" />
          {/* ...minus an offset disc, leaving a crescent. */}
          <circle cx="22" cy="13" r="11" fill="#000" />
        </mask>
      </defs>
      <circle cx="16" cy="16" r="13" fill="#F5C24B" mask="url(#crescent-mask)" />
    </svg>
  );
}

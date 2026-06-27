// Site mark: the GameCube controller icon (icons8, color). Kept the
// RandallIcon name so existing imports don't churn.
export default function RandallIcon({ size = 20 }: { size?: number }) {
  return (
    <img
      src="/favicon.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ width: size, height: size }}
    />
  );
}

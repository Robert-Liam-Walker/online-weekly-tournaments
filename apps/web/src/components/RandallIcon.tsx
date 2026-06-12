export default function RandallIcon({ size = 20 }: { size?: number }) {
  return (
    <img
      src="/favicon.png"
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
    />
  );
}

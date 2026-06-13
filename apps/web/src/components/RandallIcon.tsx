/**
 * RandallIcon — the application logo mark.
 *
 * PURPOSE
 *   Renders the Randall favicon as a sized <img>. Used in the Nav bar and
 *   anywhere a compact brand glyph is needed.
 *
 * PROPS
 *   size — pixel dimension (width and height); defaults to 20.
 *
 * WHERE USED
 *   App.tsx Nav (size 22).
 *
 * NOTE: alt="" intentionally — the icon is decorative next to the text logo;
 * it carries no additional meaning for screen readers.
 */
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

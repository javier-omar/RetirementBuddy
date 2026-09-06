interface Props {
  text: string;
  align?: "center" | "left" | "right";
}

/** Small "ⓘ" icon that reveals an explanation on hover or keyboard focus. */
export default function InfoTip({ text, align = "center" }: Props) {
  return (
    <span className={`infotip infotip-${align}`} tabIndex={0} role="note" aria-label={text}>
      <span className="infotip-icon" aria-hidden="true">i</span>
      <span className="infotip-bubble" role="tooltip">{text}</span>
    </span>
  );
}

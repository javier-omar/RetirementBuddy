import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatMoneyInput, parseMoneyInput } from "../format";

/** Count the digit characters in the first `end` chars of a string. */
function digitsBefore(s: string, end: number): number {
  return (s.slice(0, end).match(/\d/g) || []).length;
}
/** Position just after the Nth digit in a formatted string (for caret restore). */
function caretAfterDigits(formatted: string, n: number): number {
  if (n <= 0) return 0;
  let count = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i])) {
      count++;
      if (count === n) return i + 1;
    }
  }
  return formatted.length;
}

/**
 * A money text input that shows thousands separators as you type. It keeps its
 * own display string so commas don't fight the numeric value, preserves the
 * caret across reformatting, and re-syncs to `value` only when not focused (so
 * an external recalc/reset/auto-fill updates it without yanking the cursor).
 */
export default function MoneyInput({
  value,
  onValue,
  onCommit,
  className,
  placeholder,
  style,
  disabled = false,
  blankOnZero = false,
}: {
  value: number;
  onValue: (n: number) => void;
  /** Fired on blur and Enter with the parsed value, for inputs that apply
   *  changes only when editing finishes (e.g. an expensive recalc). */
  onCommit?: (n: number) => void;
  className?: string;
  placeholder?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  /** Show an empty box instead of "0" when the value is 0 (nicer for tables). */
  blankOnZero?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const focused = useRef(false);
  const external = () => (blankOnZero && !value ? "" : formatMoneyInput(String(value ?? 0)));
  const [text, setText] = useState(external);

  useEffect(() => {
    if (!focused.current) setText(external());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useLayoutEffect(() => {
    if (caret.current !== null && ref.current) {
      ref.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      className={className}
      style={style}
      placeholder={placeholder}
      disabled={disabled}
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setText(external());
        onCommit?.(parseMoneyInput(text));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit?.(parseMoneyInput(text));
      }}
      onChange={(e) => {
        const raw = e.target.value;
        const dl = digitsBefore(raw, e.target.selectionStart ?? raw.length);
        const formatted = formatMoneyInput(raw);
        caret.current = caretAfterDigits(formatted, dl);
        setText(formatted);
        onValue(parseMoneyInput(formatted));
      }}
    />
  );
}

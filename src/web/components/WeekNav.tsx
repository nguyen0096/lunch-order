import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/ui";

/**
 * One week at a time, with a way back to this one.
 *
 * Shared by the board and the menu editor deliberately. The menu editor used
 * to offer nineteen days as a wrapping strip of cards, which is a different
 * control for the same job on two screens that sit next to each other in the
 * nav -- and a longer one, since an office that eats lunch on weekdays never
 * needs the other nine days on screen at once.
 */
export function WeekNav({
  label,
  away,
  onPrev,
  onNext,
  onReset,
  children,
}: {
  label: string;
  /** Whether the reader has navigated off the current week. */
  away: boolean;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  /** Anything belonging beside the range, such as a screen's own heading. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="icon" aria-label="Previous week" onClick={onPrev}>
        <ChevronLeftIcon />
      </Button>
      <h1 className="min-w-32 text-center text-lg font-semibold tabular">{label}</h1>
      <Button variant="ghost" size="icon" aria-label="Next week" onClick={onNext}>
        <ChevronRightIcon />
      </Button>
      {/* Only once you have left, because a reset to where you already are is a
          control that does nothing, and the column head already says which day
          is today. */}
      {away && (
        <Button variant="link" className="ml-1" onClick={onReset}>
          This week
        </Button>
      )}
      {children}
    </div>
  );
}

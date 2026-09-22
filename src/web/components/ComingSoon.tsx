import type { ReactNode } from "react";
import { EmptyState } from "@/ui";

/**
 * A destination that exists in the navigation but not yet in the code.
 *
 * Deliberately a real screen rather than a dead link: a tab that goes nowhere
 * reads as a broken app, and the person deserves to be told which part is
 * missing and where the same job can be done today.
 */
export function ComingSoon({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return <EmptyState heading={heading}>{children}</EmptyState>;
}

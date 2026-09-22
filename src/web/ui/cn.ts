import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names and lets a caller's class win over a component default. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

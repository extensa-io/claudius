import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Compact relative time, e.g. "just now", "3 days ago", "2 weeks ago". */
export function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 45) return "just now"
  // Largest-first: the first unit the elapsed time reaches is the one we show.
  const units: Array<[number, string]> = [
    [31536000, "year"],
    [2592000, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ]
  for (const [threshold, label] of units) {
    if (seconds >= threshold) {
      const amount = Math.floor(seconds / threshold)
      return `${amount} ${label}${amount === 1 ? "" : "s"} ago`
    }
  }
  return `${seconds} seconds ago`
}

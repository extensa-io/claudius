"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Thin wrapper over next-themes. Dark is the brand default (design.md), but the
 * user's system preference is honored when they have one. The theme is applied
 * via the `.dark` class on <html>, matching the Tailwind variant in globals.css.
 */
export function ThemeProvider(
  props: ComponentProps<typeof NextThemesProvider>,
): React.ReactNode {
  return <NextThemesProvider {...props}>{props.children}</NextThemesProvider>;
}

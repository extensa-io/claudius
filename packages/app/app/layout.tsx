import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ClientErrorReporter } from "@/components/client-error-reporter";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Claudius",
  description: "Building my own Claude-based chatbot, powered by MongoDB.",
  // PWA / iOS Add-to-Home-Screen parity. The manifest (app/manifest.ts) covers
  // Android; these cover the iOS home-screen icon and standalone status bar.
  appleWebApp: {
    capable: true,
    title: "Claudius",
    statusBarStyle: "black-translucent",
  },
  // Declaring metadata.icons switches Next off the app/icon.svg file convention
  // for emitting <link rel="icon">, so the browser favicon must be listed here
  // explicitly alongside apple — otherwise only the apple-touch-icon link ships
  // and the tab favicon disappears.
  icons: {
    icon: "/icon.svg",
    apple: "/apple-touch-icon.png",
  },
};

// viewport-fit=cover lets the app draw under the notch / gesture bar so
// env(safe-area-inset-*) resolves to real values (the composer already pads by
// safe-area-inset-bottom). themeColor tints the Android status/URL bar to match
// the dark app chrome (#13110f = dark-theme background).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#13110f",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  return (
    // suppressHydrationWarning: next-themes sets the theme class on <html>
    // before React hydrates, so a mismatch on this node is expected and benign.
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(geistSans.variable, geistMono.variable)}
    >
      <body className="font-sans antialiased">
        <ClientErrorReporter />
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

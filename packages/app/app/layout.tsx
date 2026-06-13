import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claudius",
  description: "Building my own Claude, powered by MongoDB.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

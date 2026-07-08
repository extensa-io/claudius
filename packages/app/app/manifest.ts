import type { MetadataRoute } from "next";

/**
 * Web app manifest, served by Next at `/manifest.webmanifest`. This is what
 * makes Claudius installable as a PWA and what Bubblewrap reads to generate the
 * Android TWA (see specs/phase-9-android.md). `start_url` is `/chat` so the
 * installed app and the home-screen widget both land in the app proper; an
 * unauthenticated hit there redirects to `/` for sign-in, as it already does.
 *
 * Colors are the dark theme (the brand default in app/layout.tsx): background
 * oklch(0.18 0.006 80) → #13110f. theme_color drives the Android status/URL bar
 * tint, so it matches the app chrome.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Claudius",
    short_name: "Claudius",
    description: "My own Claude-based chatbot, powered by MongoDB.",
    start_url: "/chat",
    display: "standalone",
    background_color: "#13110f",
    theme_color: "#13110f",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      // Maskable: the launcher crops to its own shape (circle/squircle), so this
      // one carries a full-bleed aubergine field with the mark in the safe zone.
      {
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

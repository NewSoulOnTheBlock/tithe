import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LOYAL — loyalty is something you earn every day",
  description:
    "A 2% trade tax split with the people who stake. Half a share if you make no promise, triple if you lock for a week. On Robinhood Chain.",
  icons: { icon: "/logo.webp" },
  openGraph: {
    title: "LOYAL",
    description: "Loyalty is something you earn every day.",
    images: ["/logo.webp"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="font-mono antialiased">
        {/* Atmosphere. Fixed, behind everything, never interactive. */}
        <div className="ground" aria-hidden="true" />
        <div className="scan" aria-hidden="true" />
        <div className="sweepline animate-sweep" aria-hidden="true" />
        {/* No header here: `/` is a windowed shell that carries its own, and
            `/stake` mounts SiteHeader itself. A layout-level header would sit
            on top of the desktop's own top rail. */}
        {children}
      </body>
    </html>
  );
}

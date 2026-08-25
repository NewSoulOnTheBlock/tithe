import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LOYAL — loyalty is something you earn every day",
  description:
    "A 4% trade tax funding a reserve on Robinhood Chain. Stake LOYAL for a share of it — half if you make no promise, triple if you lock for a week.",
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
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://simpang.vercel.app";
const BLURB =
  "While an AI agent thinks, SIMPANG shows you the decision points it is about to resolve " +
  "and lets you kill the wrong branches — mid-run, at the agent's next tool call.";

// metadataBase is what makes the generated opengraph-image resolve to an absolute URL; without
// it a shared link unfurls with no card at all.
export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "SIMPANG — you pick the direction at every fork",
  description: BLURB,
  applicationName: "SIMPANG",
  openGraph: { title: "SIMPANG", description: BLURB, url: SITE, siteName: "SIMPANG", type: "website" },
  twitter: { card: "summary_large_image", title: "SIMPANG", description: BLURB },
};

// Not Next's generated LayoutProps: that type only exists after a build, so a clean checkout
// could not typecheck without building first.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

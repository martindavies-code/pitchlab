import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PitchLab Studio — Local-First Football Analytics & Gated Agentic Workbench",
  description:
    "Full-stack tactical football intelligence platform powered by DuckDB, FastAPI, interactive 120x80 & 105x68 SVG pitches, and a 5-stage human-in-the-loop analytical workflow.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta name="color-scheme" content="light dark" />
      </head>
      <body>{children}</body>
    </html>
  );
}

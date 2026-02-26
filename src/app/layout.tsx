import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Choose Rich Live",
  description: "Curated financial news from X, clustered and ranked",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

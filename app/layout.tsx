import "./globals.css";
import { Schibsted_Grotesk } from "next/font/google";
import type { ReactNode } from "react";

const font = Schibsted_Grotesk({ subsets: ["latin"] });

export const metadata = {
  title: "Gift agent",
  description: "Buy and send gift cards by voice, paid in USDC",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${font.className} antialiased`}>{children}</body>
    </html>
  );
}

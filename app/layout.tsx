import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Anton } from "next/font/google";
import { ClerkProvider, SignedIn } from "@clerk/nextjs";

// Editorial display face — newspaper / sports-back-page headline type.
// Single weight by design (Anton ships 400 only).
const anton = Anton({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
import { ThemeProvider } from "@/components/theme-provider";
import { TopBar } from "@/components/top-bar";
import { JerryDock } from "@/components/jerry-dock";
import "./globals.css";

export const metadata: Metadata = {
  title: "TractionOS",
  description: "Real-time collaborative L10 meeting platform with an AI copilot.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        suppressHydrationWarning
        className={`${GeistSans.variable} ${GeistMono.variable} ${anton.variable}`}
      >
        <body className="min-h-screen bg-background font-sans antialiased">
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            <TopBar />
            {children}
            <SignedIn>
              <JerryDock />
            </SignedIn>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}

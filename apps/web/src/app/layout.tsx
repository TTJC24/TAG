import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Operations Control Tower",
  description:
    "A governed operating queue for issues, recommendations, approvals, and audit history.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <a className="brand" href="/">
              <span className="brandMark">OL</span>
              <span>
                <strong>Operations Control Tower</strong>
                <small>Phase 1 · governed execution</small>
              </span>
            </a>
            <nav aria-label="Primary navigation">
              <a href="/">Executive queue</a>
              <a className="primaryNav" href="/issues/new">
                New issue
              </a>
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}

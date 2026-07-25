"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function BatchResultRefresh({ pending }: { pending: number }) {
  const router = useRouter();
  useEffect(() => {
    if (pending === 0) {
      return;
    }
    const timer = window.setInterval(() => router.refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [pending, router]);
  return null;
}

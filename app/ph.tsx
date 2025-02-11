"use client";

import posthog from "posthog-js";
import { useEffect } from "react";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init("phc_Bt8GoTBPgkCpDrbaIZzJIEYt0CrJjhBiuLaBck1clce", {
      api_host: "https://eu.i.posthog.com",
      capture_pageview: false, // we'll capture these manually
    });
  }, []);

  return <>{children}</>;
}

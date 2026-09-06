import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Repo contoh dibaca lewat fs saat runtime; tanpa ini bundel serverless Vercel tidak membawanya.
  outputFileTracingIncludes: { "/api/**": ["./examples/**/*"] },
};

export default nextConfig;

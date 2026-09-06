import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The example repo is read from the filesystem at runtime; without this the Vercel serverless bundle leaves it out.
  outputFileTracingIncludes: { "/api/**": ["./examples/**/*"] },
};

export default nextConfig;

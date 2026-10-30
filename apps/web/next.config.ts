import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const config: NextConfig = {
  output: process.env.CONTAINER_BUILD === '1' ? 'standalone' : undefined,
  outputFileTracingRoot: resolve(process.cwd(), '../..'),
  // The framework is not advertised in a header.
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // The /api pass-through holds a request body up to this size and silently cuts off the rest. Just above
    // the API's 50 MB document limit, so an upload arrives whole and the API gives the exact answer.
    proxyClientMaxBodySize: '52mb',
  },
};

export default config;

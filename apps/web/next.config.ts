import type { NextConfig } from 'next';

const config: NextConfig = {
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

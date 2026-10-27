import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  logging: {
    // dev 요청 로그는 쿼리스트링까지 남긴다. OAuth 콜백의 code·state가 로그에 남지 않도록 인증 경로는 제외한다.
    incomingRequests: { ignore: [/\/api\/auth\//] },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const isExport = process.env.NEXT_EXPORT === "true";

const nextConfig = {
  reactStrictMode: true,
  output: isExport ? "export" : "standalone",
  ...(isExport
    ? {
        basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "/pitchlab",
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;

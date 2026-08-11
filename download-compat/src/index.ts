const LEGACY_MANIFEST_PATH = "/channels/stable.json";
const LATEST_MANIFEST_PATH = "/latest/manifest.json";

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname !== LEGACY_MANIFEST_PATH) {
      return new Response("Not Found", { status: 404 });
    }

    const latestManifest = new URL(LATEST_MANIFEST_PATH, url);
    return new Response(null, {
      status: 307,
      headers: {
        Location: latestManifest.toString(),
        "Cache-Control": "public, max-age=300",
      },
    });
  },
};

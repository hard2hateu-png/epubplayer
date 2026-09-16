export default {
  async fetch(request, env) {
    if (!env.POCKET_SERVER_URL || !env.POCKET_SERVER_KEY) {
      return new Response("The speech server is being connected. Please try again shortly.", { status: 503 });
    }
    const input = new URL(request.url);
    const upstream = new URL(env.POCKET_SERVER_URL);
    upstream.pathname = input.pathname;
    upstream.search = input.search;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("cookie");
    headers.delete("authorization");
    headers.set("x-pocket-key", env.POCKET_SERVER_KEY);
    try {
      const response = await fetch(upstream, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "manual",
      });
      const output = new Headers(response.headers);
      output.delete("set-cookie");
      output.set("Cache-Control", "no-store");
      output.set("X-Content-Type-Options", "nosniff");
      output.set("Referrer-Policy", "same-origin");
      return new Response(response.body, { status: response.status, headers: output });
    } catch (_) {
      return new Response(JSON.stringify({detail:"The speech server is waking up. Please try again in a moment."}), {
        status: 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  }
};

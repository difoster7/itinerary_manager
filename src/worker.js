const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

export default {
  async fetch(request, env) {
    return json({ error: "unauthorized" }, 401);
  },
};

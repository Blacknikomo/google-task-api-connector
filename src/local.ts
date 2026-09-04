/** Local dev server: `npm run dev` (reads .env, uses in-memory token store). */
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApp().fetch, port }, () => {
  console.log(`google-tasks-connector listening on http://localhost:${port}`);
  console.log("Expose it with e.g. `ngrok http 3000` and set BASE_URL + Google redirect URI accordingly.");
});

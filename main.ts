import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { behindProxy } from "x-forwarded-fetch";
import federation from "./federation.ts";
import "./logging.ts";
import { federation as fedify } from "@fedify/hono";

const app = new Hono();

app.get("/api/test", (c) => {
    return c.json({ message: "Hello from the API!" });
});

app.use(
    "*",
    fedify(federation, async(_c) => undefined),
);

serve(
  {
    port: 8000,
    fetch: behindProxy(
        app.fetch
    ),
  },
  (info) =>
    console.log("Server started at http://" + info.address + ":" + info.port)
);

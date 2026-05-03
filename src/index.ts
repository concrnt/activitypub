// @ts-nocheck this file is just a template
import { serve } from "@hono/node-server";
import { behindProxy } from "x-forwarded-fetch";
import app from "./app.ts";
import "./logging.ts";
import { startEntityBroker } from "./daemon.ts";
import { config } from "./config.ts";

startEntityBroker()

serve(
  {
    port: config.server.port,
    fetch: behindProxy(app.fetch.bind(app)),
  },
  (info) =>
    console.log("Server started at http://" + info.address + ":" + info.port),
);

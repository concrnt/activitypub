import { serve } from "@hono/node-server";
import { behindProxy } from "x-forwarded-fetch";
import { getLogger } from "@logtape/logtape";
import app from "./app.ts";
import "./logging.ts";
import { startEntityBroker } from "./daemon.ts";
import { config } from "./config.ts";

const logger = getLogger("activitypub");

startEntityBroker()

serve(
  {
    port: config.server.port,
    fetch: behindProxy(app.fetch.bind(app)),
  },
  (info) =>
    logger.info(`Server started at http://${info.address}:${info.port}`),
);

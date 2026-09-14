import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { AcpRegistryCatalog } from "../acp/AcpRegistrySupport.ts";

/** Server-lifetime catalog shared by provider setup, health checks, and sessions. */
export const AcpRegistryCatalogLive = Layer.unwrap(
  Effect.map(ServerConfig, (config) =>
    AcpRegistryCatalog.layer({ cacheDir: config.providerStatusCacheDir }),
  ),
);

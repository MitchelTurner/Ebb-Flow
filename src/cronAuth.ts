import type { Request, Response } from "express";
import type { AppConfig } from "./config.js";

/** Authorize /cron/* — requires CRON_SECRET in production by default. */
export function authorizeCron(
  config: AppConfig,
  req: Request,
  res: Response
): boolean {
  const secret = config.cronSecret?.trim();
  const isProd = process.env.NODE_ENV === "production";

  if (!secret) {
    if (isProd && config.requireCronSecretInProduction) {
      res.status(503).json({
        error:
          "CRON_SECRET is required in production. Set it on the web service and pass Authorization: Bearer <secret>.",
      });
      return false;
    }
    return true;
  }

  const header = req.get("authorization") ?? "";
  if (header !== `Bearer ${secret}`) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

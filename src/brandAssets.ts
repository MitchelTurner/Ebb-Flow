import { readFileSync } from "node:fs";
import { resolveBrandFile } from "./assetPaths.js";

/** CID used for Resend inline logo attachments. */
export const BRAND_LOGO_CID = "ebb-flow-logo";

/** Light mark (cream) for navy / dark mastheads. */
export const BRAND_LOGO_LIGHT_PNG = "logo-mark-light-128.png";
export const BRAND_LOGO_LIGHT_SVG = "logo-mark-light.svg";

export type LogoDelivery = "hosted" | "cid" | "relative";

export function brandLogoUrl(
  delivery: LogoDelivery,
  appUrl: string
): string {
  if (delivery === "cid") return `cid:${BRAND_LOGO_CID}`;
  if (delivery === "relative") return `/brand/${BRAND_LOGO_LIGHT_PNG}`;
  return `${appUrl.replace(/\/$/, "")}/brand/${BRAND_LOGO_LIGHT_PNG}`;
}

export function loadBrandLogoPng(): {
  filename: string;
  content: Buffer;
  contentType: "image/png";
  contentId: string;
} | null {
  const path = resolveBrandFile(BRAND_LOGO_LIGHT_PNG);
  if (!path) return null;
  return {
    filename: BRAND_LOGO_LIGHT_PNG,
    content: readFileSync(path),
    contentType: "image/png",
    contentId: BRAND_LOGO_CID,
  };
}

/** Resend attachment shape (v4 uses inlineContentId). */
export function brandLogoResendAttachment():
  | {
      filename: string;
      content: Buffer;
      contentType: string;
      inlineContentId: string;
    }
  | null {
  const logo = loadBrandLogoPng();
  if (!logo) return null;
  return {
    filename: logo.filename,
    content: logo.content,
    contentType: logo.contentType,
    inlineContentId: logo.contentId,
  };
}

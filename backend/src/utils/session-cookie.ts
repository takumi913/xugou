import { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Bindings } from "../models/db";
import { generateSecureToken } from "./crypto";
import { AuthVariables } from "../types";

export const SESSION_COOKIE_NAME = "xugou_session";
export const CSRF_COOKIE_NAME = "xugou_csrf";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

type AppContext = Context<{ Bindings: Bindings; Variables: AuthVariables }>;

function cookieSecurity(c: AppContext) {
  return new URL(c.req.url).protocol === "https:";
}

export function setAdminSessionCookies(
  c: AppContext,
  token: string,
  expiresAt: string
) {
  const common = {
    path: "/",
    secure: cookieSecurity(c),
    sameSite: "Strict" as const,
    expires: new Date(expiresAt),
  };

  setCookie(c, SESSION_COOKIE_NAME, token, {
    ...common,
    httpOnly: true,
  });
  setCookie(c, CSRF_COOKIE_NAME, generateSecureToken(32), {
    ...common,
    httpOnly: false,
  });
}

export function clearAdminSessionCookies(c: AppContext) {
  const options = { path: "/", secure: cookieSecurity(c) };
  deleteCookie(c, SESSION_COOKIE_NAME, options);
  deleteCookie(c, CSRF_COOKIE_NAME, options);
}

export function getAdminSessionCookie(c: AppContext) {
  return getCookie(c, SESSION_COOKIE_NAME) ?? null;
}

export function getCsrfCookie(c: AppContext) {
  return getCookie(c, CSRF_COOKIE_NAME) ?? null;
}

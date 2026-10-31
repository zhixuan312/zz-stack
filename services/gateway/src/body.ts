/**
 * The gateway's request-body parsers, and the answer to a body they cannot read.
 *
 * A malformed body fails inside the parser, before any route, and Express's default handler then
 * answers with an HTML page carrying the stack — absolute paths included — whenever NODE_ENV is not
 * `production`, on routes as public as /oauth/register. The handler here answers in the
 * `{error, error_description}` shape every refusal on those routes already uses.
 */
import express, { type ErrorRequestHandler, type Express } from "express";

/** What body-parser attaches to an error it raised: `type` names the failure, `expose` says its
 *  message describes the request rather than the server. */
type BodyError = { type?: unknown; status?: number; expose?: boolean; message?: string };

const unreadable: ErrorRequestHandler = (err: BodyError, _req, res, next) => {
  if (typeof err?.type !== "string") { next(err); return; }
  res.status(err.status ?? 400).json({
    error: "invalid_request",
    error_description: err.expose && err.message ? `the request body could not be read: ${err.message}`
      : "the request body could not be read",
  });
};

/** JSON and form bodies, then the refusal of either when it does not parse. Mounted after the
 *  upload routes, which read their own bodies. */
export function mountBodyParsers(app: Express): void {
  app.use(express.json({ limit: "20mb" }));
  // The OAuth token endpoint is form-encoded, and only this line makes ours one: RFC 6749
  // §4.1.3 requires `application/x-www-form-urlencoded` there, and the MCP SDK sends it. With
  // json() alone `req.body` is empty for every exchange and the endpoint answers
  // `unsupported_grant_type`.
  //
  // Body parsers are content-type gated, so this only runs on a form-encoded request and
  // changes nothing about the JSON routes. `extended: false` because these bodies are flat
  // key-value pairs.
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(unreadable);
}

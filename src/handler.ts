/** AWS Lambda entry point (API Gateway HTTP API v2 payload), ADR 0003. */
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";

export const handler = handle(createApp());

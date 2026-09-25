import { createFileRoute } from "@tanstack/react-router";
import { handleApi } from "../server/api.ts";

const handler = ({ request }: { request: Request }) => handleApi(request);
export const Route = createFileRoute("/api/$")({ server: {
  handlers: { GET: handler, POST: handler, PUT: handler, PATCH: handler, DELETE: handler },
} });

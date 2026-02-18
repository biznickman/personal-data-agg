import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import {
  xNewsIngest,
  xKeywordScan,
  granolaIngest,
  messageLogIngest,
} from "@/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [xNewsIngest, xKeywordScan, granolaIngest, messageLogIngest],
});

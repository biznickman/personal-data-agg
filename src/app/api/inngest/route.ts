import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import {
  xNewsIngest,
  xKeywordScan,
  xNewsEnrichUrls,
  xNewsNormalize,
  granolaIngest,
  messageLogIngest,
  xPostsFetchRecent,
  xPostsUpdateAnalytics,
  xPostsArchive,
} from "@/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    xNewsIngest,
    xKeywordScan,
    xNewsEnrichUrls,
    xNewsNormalize,
    granolaIngest,
    messageLogIngest,
    xPostsFetchRecent,
    xPostsUpdateAnalytics,
    xPostsArchive,
  ],
});

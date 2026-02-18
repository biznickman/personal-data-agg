/**
 * All Inngest functions — registered with the serve handler.
 *
 * Each data source lives in its own subfolder.
 * Add new sources by creating a folder, exporting functions, and adding them here.
 */

// X/Twitter
export { xNewsIngest, xKeywordScan } from "./x-news";

// Granola meeting notes
export { granolaIngest } from "./granola";

// Message log (session transcripts)
export { messageLogIngest } from "./messages";

// Future data sources:
// export { slackIngest } from "./slack";
// export { pipedrivSync } from "./pipedrive";
// export { rssIngest } from "./rss";
// export { youtubeCompetitorSync } from "./youtube";

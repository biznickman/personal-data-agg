import { supabase } from "@/lib/supabase";

export class SourcesModel {
  static async listActiveAccounts(): Promise<string[]> {
    const { data, error } = await supabase
      .from("x_news_sources")
      .select("name")
      .eq("source_type", "account")
      .eq("is_active", true);

    if (error) {
      throw new Error(`Failed to load active accounts: ${error.message}`);
    }

    return (data ?? []).map((row) => row.name as string);
  }

  static async listActiveKeywordQueries(): Promise<string[]> {
    const { data, error } = await supabase
      .from("x_news_sources")
      .select("query")
      .eq("source_type", "keyword")
      .eq("is_active", true);

    if (error) {
      throw new Error(`Failed to load active keyword queries: ${error.message}`);
    }

    return (data ?? [])
      .map((row) => row.query as string | null)
      .filter((q): q is string => q !== null);
  }
}
